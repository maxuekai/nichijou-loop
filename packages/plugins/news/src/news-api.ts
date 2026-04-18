import type { NewsAPIResponse, NewsArticle, NewsFetchParams, CacheEntry } from "./types.js";

// 内存缓存
const newsCache = new Map<string, CacheEntry<NewsAPIResponse>>();

function resolveApiKey(params: Record<string, unknown>): string {
  const key = (params.newsApiKey as string) || process.env.NEWS_API_KEY || "";
  if (!key) {
    throw new Error("NewsAPI Key 未配置。请在管理后台「插件管理」中配置新闻插件的 newsApiKey，或设置环境变量 NEWS_API_KEY。");
  }
  return key;
}

function getCacheKey(params: NewsFetchParams): string {
  return JSON.stringify({
    category: params.category || "technology",
    country: params.country || "us",
    language: params.language || "en",
    limit: params.limit || 5,
  });
}

function isValidCache<T>(entry: CacheEntry<T>): boolean {
  return Date.now() - entry.timestamp < entry.expireAfter;
}

function formatNewsForAI(articles: NewsArticle[], limit: number): string {
  const limitedArticles = articles.slice(0, limit);
  
  const formatTime = (publishedAt: string) => {
    const date = new Date(publishedAt);
    const now = new Date();
    const diffHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60));
    
    if (diffHours < 1) return "刚刚";
    if (diffHours < 24) return `${diffHours}小时前`;
    if (diffHours < 48) return "昨天";
    return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  };

  const newsText = limitedArticles.map((article, index) => {
    const time = formatTime(article.publishedAt);
    const source = article.source.name;
    const description = article.description || "暂无描述";
    
    // 生成新闻ID（使用索引和URL的hash）
    const newsId = `news_${index + 1}_${Buffer.from(article.url).toString('base64').slice(0, 8)}`;
    
    return `${index + 1}. 【${source}】${article.title}
   发布时间: ${time}
   摘要: ${description}
   链接: ${article.url}
   新闻ID: ${newsId}`;
  }).join("\n\n");

  const summary = `📰 获取到 ${limitedArticles.length} 条新闻：\n\n${newsText}
  
💡 使用说明：如需查看某条新闻的详细信息，请使用对应的新闻ID调用详情功能。`;
  
  return summary;
}

async function fetchNewsFromAPI(params: NewsFetchParams, apiKey: string): Promise<NewsAPIResponse> {
  // 构建 NewsAPI URL
  const category = params.category || "technology";
  const country = params.country || "us";
  const language = params.language || "en";
  
  // NewsAPI 免费版只支持 top-headlines
  const url = new URL("https://newsapi.org/v2/top-headlines");
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("category", category);
  url.searchParams.set("country", country);
  url.searchParams.set("pageSize", String(Math.min(params.limit || 5, 20)));
  
  // 如果是中文，调整参数
  if (language === "zh") {
    url.searchParams.delete("country");
    url.searchParams.set("sources", ""); // 移除 sources 参数让 NewsAPI 自动选择
    url.searchParams.set("q", "科技"); // 添加中文关键词
  }

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(8000),
    headers: {
      "User-Agent": "Nichijou-News-Plugin/1.0",
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("NewsAPI Key 无效，请检查配置");
    }
    if (response.status === 429) {
      throw new Error("NewsAPI 调用次数超限，请稍后再试或升级账户");
    }
    throw new Error(`NewsAPI 请求失败: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as NewsAPIResponse;
  
  if (data.status !== "ok") {
    throw new Error(`NewsAPI 返回错误: ${data.status}`);
  }

  return data;
}

export async function fetchNews(
  params: NewsFetchParams,
  config: Record<string, unknown>
): Promise<{ content: string; isError?: boolean }> {
  try {
    const apiKey = resolveApiKey(config);
    const cacheKey = getCacheKey(params);
    const cacheExpireMinutes = (config.newsCacheMinutes as number) || 15;
    const cacheExpireMs = cacheExpireMinutes * 60 * 1000;

    // 检查缓存
    if (config.enableCache !== false) {
      const cached = newsCache.get(cacheKey);
      if (cached && isValidCache(cached)) {
        const formattedNews = formatNewsForAI(cached.data.articles, params.limit || 5);
        return { content: `${formattedNews}\n\n📝 数据来自缓存（${Math.floor((Date.now() - cached.timestamp) / 60000)}分钟前）` };
      }
    }

    // 从 API 获取新数据
    const newsData = await fetchNewsFromAPI(params, apiKey);
    
    // 缓存结果
    if (config.enableCache !== false) {
      newsCache.set(cacheKey, {
        data: newsData,
        timestamp: Date.now(),
        expireAfter: cacheExpireMs,
      });
    }

    // 格式化返回给 AI
    const formattedNews = formatNewsForAI(newsData.articles, params.limit || 5);
    return { content: formattedNews };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // 尝试返回缓存数据作为降级
    const cacheKey = getCacheKey(params);
    const cached = newsCache.get(cacheKey);
    if (cached && config.enableCache !== false) {
      const formattedNews = formatNewsForAI(cached.data.articles, params.limit || 5);
      return { 
        content: `⚠️ 获取最新新闻失败（${errorMessage}），显示缓存内容：\n\n${formattedNews}` 
      };
    }

    return {
      content: `新闻获取失败: ${errorMessage}`,
      isError: true,
    };
  }
}

// 根据 newsId 查找新闻详情
export function findNewsByNewsId(newsId: string): NewsArticle | null {
  // 解析 newsId 格式: news_{index}_{hash}
  const match = newsId.match(/^news_(\d+)_(.+)$/);
  if (!match) return null;
  
  const [, indexStr] = match;
  const targetIndex = parseInt(indexStr) - 1; // 转换为0索引
  
  // 遍历缓存查找匹配的新闻
  for (const [, entry] of newsCache.entries()) {
    if (targetIndex >= 0 && targetIndex < entry.data.articles.length) {
      const article = entry.data.articles[targetIndex];
      // 验证 hash 是否匹配
      const expectedHash = Buffer.from(article.url).toString('base64').slice(0, 8);
      if (match[2] === expectedHash) {
        return article;
      }
    }
  }
  
  return null;
}

// 清理过期缓存的工具函数
export function cleanExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of newsCache.entries()) {
    if (now - entry.timestamp >= entry.expireAfter) {
      newsCache.delete(key);
    }
  }
}