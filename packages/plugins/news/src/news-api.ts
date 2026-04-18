import type { NewsAPIResponse, NewsArticle, NewsFetchParams, CacheEntry } from "./types.js";

// 中文RSS新闻源配置
const chineseRSSFeeds = {
  technology: [
    { name: "IT之家", url: "https://www.ithome.com/rss/" },
    { name: "36氪", url: "https://36kr.com/feed" },
    { name: "虎嗅", url: "https://www.huxiu.com/rss/0.xml" },
    { name: "少数派", url: "https://sspai.com/feed" }
  ],
  business: [
    { name: "财经网", url: "http://www.caijing.com.cn/rss/news.xml" },
    { name: "新浪财经", url: "https://finance.sina.com.cn/roll/finance_roll.shtml" }
  ],
  general: [
    { name: "新浪新闻", url: "https://news.sina.com.cn/roll/news_roll.shtml" },
    { name: "网易新闻", url: "http://news.163.com/special/00011K6L/rss_newstop.xml" }
  ]
};

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

// 从RSS获取中文新闻
async function fetchChineseNewsFromRSS(params: NewsFetchParams): Promise<NewsAPIResponse> {
  const category = params.category || "technology";
  const feeds = chineseRSSFeeds[category as keyof typeof chineseRSSFeeds] || chineseRSSFeeds.technology;
  
  const allArticles: NewsArticle[] = [];
  
  // 尝试获取多个RSS源的内容
  for (const feed of feeds.slice(0, 2)) { // 只取前2个源避免太慢
    try {
      // 创建兼容的AbortController和超时处理
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      
      const response = await fetch(feed.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        },
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) continue;
      
      const xmlText = await response.text();
      
      // 解析RSS项目
      const itemRegex = /<item[\s\S]*?<\/item>/gi;
      const items = xmlText.match(itemRegex) || [];
      
      for (const item of items.slice(0, 5)) { // 每个源取5条
        const title = parseXMLField(item, 'title');
        const description = parseXMLField(item, 'description');
        const link = parseXMLField(item, 'link');
        const pubDate = parseXMLField(item, 'pubDate');
        
        if (title && link) {
          allArticles.push({
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
    } catch (error) {
      console.warn(`获取RSS源 ${feed.name} 失败:`, error);
      continue;
    }
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
    
    // 生成新闻ID（使用索引和URL的简单hash）
    const simpleHash = article.url.split('').reduce((acc, char) => {
      return ((acc << 5) - acc + char.charCodeAt(0)) & 0xffffffff;
    }, 0).toString(16).slice(0, 8);
    const newsId = `news_${index + 1}_${simpleHash}`;
    
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

// fetchNewsFromAPI 函数已移除，现在专注于免费的 RSS 源

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

  // 使用免费的中文RSS源获取新闻
  try {
    const newsData = await fetchChineseNewsFromRSS(params);
    
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
    console.warn('RSS源获取失败:', error);
    
    // 尝试返回缓存数据作为降级
    const cached = newsCache.get(cacheKey);
    if (cached && config.enableCache !== false) {
      const formattedNews = formatNewsForAI(cached.data.articles, params.limit || 5);
      return { 
        content: `⚠️ 获取最新新闻失败，显示缓存内容：\n\n${formattedNews}` 
      };
    }

    return {
      content: `新闻获取失败: RSS源无法访问。请检查网络连接或稍后重试。`,
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
      // 验证 hash 是否匹配（使用同样的简单hash算法）
      const expectedHash = article.url.split('').reduce((acc, char) => {
        return ((acc << 5) - acc + char.charCodeAt(0)) & 0xffffffff;
      }, 0).toString(16).slice(0, 8);
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