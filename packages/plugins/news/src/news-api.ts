import type { NewsAPIResponse, NewsArticle, NewsFetchParams, CacheEntry } from "./types.js";

// 中文RSS新闻源配置（包含科技、娱乐、文化等各类源）
const availableRSSFeeds = [
  // 科技新闻
  { name: "IT之家", url: "https://www.ithome.com/rss/" },
  { name: "36氪", url: "https://36kr.com/feed" },
  { name: "少数派", url: "https://sspai.com/feed" },
  { name: "爱范儿", url: "https://www.ifanr.com/feed" },
  
  // 综合新闻
  { name: "网易新闻", url: "http://news.163.com/special/00011K6L/rss_newstop.xml" },
  
  // 娱乐文化
  { name: "豆瓣影评", url: "https://www.douban.com/feed/review/movie" },
  { name: "知乎日报", url: "https://feeds.feedburner.com/zhihu-daily" }
];

// 内存缓存
const newsCache = new Map<string, CacheEntry<NewsAPIResponse>>();

// NewsAPI 相关代码已移除，现在专注于 RSS 源

// 简单的XML解析函数
function parseXMLField(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';
  
  // 清理HTML标签和特殊字符
  return match[1]
    .replace(/<!\[CDATA\[([^\]]+)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

// RSS 源获取结果类型
type RSSFeedResult = {
  success: true;
  articles: NewsArticle[];
  feedName: string;
} | {
  success: false;
  error: string;
  feedName: string;
};

// 从RSS获取中文新闻（简化版，不再分类）
async function fetchChineseNewsFromRSS(params: NewsFetchParams, config: Record<string, unknown> = {}): Promise<NewsAPIResponse> {
  const enabledFeeds = availableRSSFeeds;
  
  if (enabledFeeds.length === 0) {
    console.warn('没有可用的RSS源');
    return {
      status: 'ok',
      totalResults: 0,
      articles: []
    };
  }
  
  const allArticles: NewsArticle[] = [];
  
  // 尝试获取多个RSS源的内容，增加并发和更好的错误处理
  const fetchPromises = enabledFeeds.slice(0, 3).map(async (feed): Promise<RSSFeedResult> => {
    try {
      // 创建兼容的AbortController和超时处理，增加超时时间
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.warn(`RSS源 ${feed.name} 请求超时，正在取消...`);
        controller.abort();
      }, 15000); // 增加到15秒
      
      const response = await fetch(feed.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml',
          'Cache-Control': 'no-cache',
        },
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const xmlText = await response.text();
      
      // 解析RSS项目
      const itemRegex = /<item[\s\S]*?<\/item>/gi;
      const items = xmlText.match(itemRegex) || [];
      
      const feedArticles: NewsArticle[] = [];
      for (const item of items.slice(0, 5)) { // 每个源取5条
        const title = parseXMLField(item, 'title');
        const description = parseXMLField(item, 'description');
        const link = parseXMLField(item, 'link');
        const pubDate = parseXMLField(item, 'pubDate');
        
        if (title && link) {
          feedArticles.push({
            source: { id: null, name: feed.name },
            author: null,
            title,
            description: description || '暂无描述',
            url: link,
            urlToImage: null,
            publishedAt: pubDate || new Date().toISOString(),
            content: null
          });
        }
      }
      
      return { success: true, articles: feedArticles, feedName: feed.name };
    } catch (error) {
      console.warn(`获取RSS源 ${feed.name} 失败:`, error instanceof Error ? error.message : String(error));
      return { success: false, error: error instanceof Error ? error.message : String(error), feedName: feed.name };
    }
  });
  
  // 等待所有请求完成，不管成功失败
  const results = await Promise.allSettled(fetchPromises);
  
  // 收集成功的结果
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.success && result.value.articles) {
      allArticles.push(...result.value.articles);
    }
  }
  
  // 如果没有获取到任何文章，但有一些源失败了，记录详细错误
  if (allArticles.length === 0) {
    const errors = results
      .filter((r): r is PromiseFulfilledResult<RSSFeedResult> => 
        r.status === 'fulfilled' && !r.value.success)
      .map(r => {
        const failedResult = r.value as Extract<RSSFeedResult, { success: false }>;
        return `${failedResult.feedName}: ${failedResult.error}`;
      })
      .join('; ');
    
    const rejections = results
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message || String(r.reason))
      .join('; ');
      
    console.error('所有RSS源都失败了:', { errors, rejections });
  }
  
  // 按发布时间排序
  allArticles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  
  return {
    status: 'ok',
    totalResults: allArticles.length,
    articles: allArticles
  };
}

function getCacheKey(params: NewsFetchParams): string {
  return JSON.stringify({
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
    
    return `${index + 1}. 【${source}】${article.title}
   发布时间: ${time}
   摘要: ${description}
   链接: ${article.url}`;
  }).join("\n\n");

  const summary = `📰 获取到 ${limitedArticles.length} 条新闻：\n\n${newsText}`;
  
  return summary;
}

export async function fetchNews(
  params: NewsFetchParams,
  config: Record<string, unknown>
): Promise<{ content: string; isError?: boolean }> {
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

  // 使用免费的中文RSS源获取新闻，增加超时和错误处理
  let newsData: NewsAPIResponse | null = null;
  let errorMessage = '';
  
  try {
    // 设置整体超时，防止长时间卡死
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('整体获取超时')), 30000); // 30秒总超时
    });
    
    newsData = await Promise.race([
      fetchChineseNewsFromRSS(params, config),
      timeoutPromise
    ]);
    
    // 即使获取成功，也检查是否有文章
    if (!newsData || newsData.articles.length === 0) {
      throw new Error('未获取到任何新闻文章');
    }
    
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
    return { content: `${formattedNews}\n\n📡 数据来源：免费RSS源` };
    
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('RSS源获取失败:', errorMessage);
  }

  // 尝试返回缓存数据作为降级
  if (config.enableCache !== false) {
    const cached = newsCache.get(cacheKey);
    if (cached) {
      const formattedNews = formatNewsForAI(cached.data.articles, params.limit || 5);
      const cacheAge = Math.floor((Date.now() - cached.timestamp) / 60000);
      return { 
        content: `⚠️ 获取最新新闻失败（${errorMessage}），显示缓存内容：\n\n${formattedNews}\n\n📝 缓存时间：${cacheAge}分钟前` 
      };
    }
  }

  // 最后的降级：返回友好的错误信息，但不标记为error（避免LLM处理异常）
  return {
    content: `📢 暂时无法获取最新新闻\n\n原因：${errorMessage}\n\n建议：\n• 请稍后重试\n• 检查网络连接\n• 如果问题持续，请联系管理员\n\n🤖 我仍然可以为您提供其他服务，比如天气查询、GitHub项目推荐等。`,
    isError: false, // 改为false，避免LLM异常
  };
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
