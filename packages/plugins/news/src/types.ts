// News API 相关类型
export interface NewsAPIResponse {
  status: string;
  totalResults: number;
  articles: NewsArticle[];
}

export interface NewsArticle {
  source: {
    id: string | null;
    name: string;
  };
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string;
  content: string | null;
}

// GitHub API 相关类型
export interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepository[];
}

export interface GitHubRepository {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  topics: string[];
}

// 插件配置类型
export interface NewsPluginConfig {
  githubToken?: string;
  defaultCategory?: "technology" | "business" | "science" | "general";
  defaultLanguage?: "zh" | "en";
  githubHotness?: "active" | "new" | "popular";
  githubMinStars?: number;
  enableCache?: boolean;
  newsCacheMinutes?: number;
  githubCacheMinutes?: number;
  enabledRSSSources?: string[]; // 启用的RSS源名称列表
}

// 工具参数类型
export interface NewsFetchParams {
  category?: "technology" | "business" | "science" | "general";
  country?: "cn" | "us";
  limit?: number;
  language?: "zh" | "en";
}

export interface GitHubProjectsParams {
  hotness?: "active" | "new" | "popular";
  language?: "python" | "javascript" | "typescript" | "all";
  minStars?: number;
  recentDays?: number;
  limit?: number;
}

export interface NewsDetailParams {
  newsId: string;
  url?: string;
}

// 缓存类型
export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expireAfter: number;
}