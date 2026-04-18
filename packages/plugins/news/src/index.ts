import { definePlugin } from "@nichijou/plugin-sdk";
import type { NewsFetchParams, GitHubProjectsParams, NewsDetailParams } from "./types.js";
import { fetchNews, cleanExpiredCache, findNewsByNewsId } from "./news-api.js";
import { fetchGitHubProjects, cleanExpiredGitHubCache } from "./github-api.js";

// 定期清理过期缓存（每10分钟执行一次）
setInterval(() => {
  try {
    cleanExpiredCache();
    cleanExpiredGitHubCache();
  } catch (error) {
    // 静默处理缓存清理错误，避免影响主功能
    console.warn("新闻插件缓存清理失败:", error);
  }
}, 10 * 60 * 1000);

async function fetchNewsDetail(params: NewsDetailParams): Promise<{ content: string; isError?: boolean }> {
  try {
    const { newsId, url } = params;
    
    let targetUrl = url;
    let article = null;
    
    // 尝试通过 newsId 查找新闻
    if (newsId && !targetUrl) {
      article = findNewsByNewsId(newsId);
      if (article) {
        targetUrl = article.url;
      }
    }
    
    if (!targetUrl) {
      return { 
        content: "未找到对应的新闻信息。请提供有效的 newsId 或新闻 URL。", 
        isError: true 
      };
    }
    
    // 构建详细信息响应
    let detailResponse = `📰 新闻详情\n\n`;
    
    if (article) {
      const formatTime = (publishedAt: string) => {
        const date = new Date(publishedAt);
        return date.toLocaleString("zh-CN");
      };
      
      detailResponse += `标题：${article.title}
来源：${article.source.name}
作者：${article.author || "未知"}
发布时间：${formatTime(article.publishedAt)}
摘要：${article.description || "暂无摘要"}

🔗 原文链接：${targetUrl}
`;

      // 如果有content字段且不为空，显示部分内容
      if (article.content && article.content.trim()) {
        detailResponse += `\n📄 内容预览：
${article.content.length > 200 ? article.content.substring(0, 200) + "..." : article.content}
`;
      }
    } else {
      detailResponse += `🔗 新闻链接：${targetUrl}
`;
    }
    
    detailResponse += `
💡 获取完整内容的方式：
1. 点击上方链接直接访问原文
2. 复制链接内容，我可以帮你分析总结
3. 升级NewsAPI到付费版本获取完整文章内容

⚠️ 说明：当前使用NewsAPI免费版本
• 免费版只提供标题、摘要和链接
• 如需完整文章内容，建议升级到付费版本
• 或者直接分享文章内容，我来帮你总结分析

🤖 我还可以帮你：
• 查找相关的技术项目和资源
• 分析新闻趋势和影响
• 回答基于标题和摘要的问题`;

    return { content: detailResponse };
    
  } catch (error) {
    return {
      content: `新闻详情获取失败: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

export default definePlugin({
  id: "news",
  name: "新闻助手",
  description: "获取最新科技新闻和 GitHub 热门 AI 项目信息，支持定时推送和交互式查看",
  version: "0.1.0",

  configSchema: {
    newsApiKey: {
      type: "string",
      description: "NewsAPI.org 的 API Key",
      required: true,
    },
    githubToken: {
      type: "string",
      description: "GitHub 访问令牌（可选，用于提高 API 限额）",
      required: false,
    },
    defaultCategory: {
      type: "string",
      description: "默认新闻分类",
      default: "technology",
      required: false,
    },
    defaultLanguage: {
      type: "string",
      description: "默认语言",
      default: "zh",
      required: false,
    },
    githubHotness: {
      type: "string",
      description: "GitHub 项目热度策略：active(活跃)、new(新项目)、popular(热门)",
      default: "active",
      required: false,
    },
    githubMinStars: {
      type: "number",
      description: "GitHub 项目最小 star 数",
      default: 50,
      required: false,
    },
    enableCache: {
      type: "boolean",
      description: "启用缓存减少 API 调用",
      default: true,
      required: false,
    },
    newsCacheMinutes: {
      type: "number",
      description: "新闻缓存时间（分钟）",
      default: 15,
      required: false,
    },
    githubCacheMinutes: {
      type: "number",
      description: "GitHub 缓存时间（分钟）",
      default: 30,
      required: false,
    },
  },

  tools: [
    {
      name: "news_fetch",
      description:
        "获取最新新闻摘要。可指定分类（technology/business/science/general）、" +
        "国家（cn/us）、数量限制和语言。返回格式化的新闻内容供 AI 处理。",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["technology", "business", "science", "general"],
            description: "新闻分类",
          },
          country: {
            type: "string",
            enum: ["cn", "us"],
            description: "国家代码",
          },
          limit: {
            type: "number",
            description: "返回新闻数量，默认 5",
            minimum: 1,
            maximum: 20,
          },
          language: {
            type: "string",
            enum: ["zh", "en"],
            description: "语言偏好",
          },
        },
        required: [],
      },
      execute: async (params) => {
        try {
          // 这里的 params 已经包含了插件配置和调用参数的合并结果
          return await fetchNews(params as NewsFetchParams, params);
        } catch (err) {
          return {
            content: `新闻获取失败: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "github_ai_projects",
      description:
        "获取 GitHub 上热门的 AI/机器学习项目。支持按热度策略（active/new/popular）、" +
        "编程语言、最小 star 数等条件筛选。",
      parameters: {
        type: "object",
        properties: {
          hotness: {
            type: "string",
            enum: ["active", "new", "popular"],
            description: "热度策略：active(近期活跃+高star)、new(最近创建)、popular(纯star排序)",
          },
          language: {
            type: "string",
            enum: ["python", "javascript", "typescript", "all"],
            description: "编程语言筛选",
          },
          minStars: {
            type: "number",
            description: "最小 star 数",
            minimum: 0,
          },
          recentDays: {
            type: "number",
            description: "用于 active 和 new 策略的近期天数",
            minimum: 1,
            maximum: 365,
          },
          limit: {
            type: "number",
            description: "返回项目数量，默认 5",
            minimum: 1,
            maximum: 20,
          },
        },
        required: [],
      },
      execute: async (params) => {
        try {
          // 这里的 params 已经包含了插件配置和调用参数的合并结果
          return await fetchGitHubProjects(params as GitHubProjectsParams, params);
        } catch (err) {
          return {
            content: `GitHub 项目获取失败: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "news_detail",
      description:
        "获取特定新闻的详细内容。可通过新闻 ID 或 URL 获取完整文章内容，" +
        "支持用户追问具体新闻的详情。",
      parameters: {
        type: "object",
        properties: {
          newsId: {
            type: "string",
            description: "新闻 ID（来自 news_fetch 返回的结果）",
          },
          url: {
            type: "string",
            description: "新闻 URL（替代方案）",
          },
        },
        required: ["newsId"],
      },
      execute: async (params) => {
        try {
          // 验证必需参数
          const newsId = typeof params.newsId === "string" ? params.newsId.trim() : "";
          if (!newsId) {
            return { content: "新闻详情获取失败: newsId 参数必填", isError: true };
          }
          
          const detailParams: NewsDetailParams = {
            newsId,
            url: typeof params.url === "string" ? params.url : undefined,
          };
          
          return await fetchNewsDetail(detailParams);
        } catch (err) {
          return {
            content: `新闻详情获取失败: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ],

  dashboardWidgets: [
    { id: "news-summary", name: "新闻摘要", component: "NewsSummary", defaultSize: "medium" },
    { id: "github-trending", name: "GitHub 热门", component: "GitHubTrending", defaultSize: "small" },
  ],
});