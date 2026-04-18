import type { GitHubSearchResponse, GitHubRepository, GitHubProjectsParams, CacheEntry } from "./types.js";

// 内存缓存
const githubCache = new Map<string, CacheEntry<GitHubSearchResponse>>();

function getGitHubToken(params: Record<string, unknown>): string | undefined {
  return (params.githubToken as string) || process.env.GITHUB_TOKEN || undefined;
}

function getCacheKey(params: GitHubProjectsParams): string {
  return JSON.stringify({
    hotness: params.hotness || "active",
    language: params.language || "all",
    minStars: params.minStars || 50,
    recentDays: params.recentDays || 7,
    limit: params.limit || 5,
  });
}

function isValidCache<T>(entry: CacheEntry<T>): boolean {
  return Date.now() - entry.timestamp < entry.expireAfter;
}

function buildSearchQuery(params: GitHubProjectsParams): string {
  const hotness = params.hotness || "active";
  const language = params.language || "all";
  const minStars = params.minStars || 50;
  const recentDays = params.recentDays || 7;
  
  // 计算日期范围
  const now = new Date();
  const pastDate = new Date(now.getTime() - recentDays * 24 * 60 * 60 * 1000);
  const dateStr = pastDate.toISOString().split('T')[0]; // YYYY-MM-DD 格式
  
  // 简化的查询：使用最基础的机器学习标签
  let query = "topic:machine-learning";
  
  // 添加 star 数过滤（降低要求）
  query += ` stars:>${Math.max(minStars, 10)}`;
  
  // 根据热度策略添加时间过滤
  if (hotness === "active") {
    // 近期有提交的项目
    query += ` pushed:>${dateStr}`;
  } else if (hotness === "new") {
    // 近期创建的项目
    query += ` created:>${dateStr}`;
  }
  // popular 策略不添加时间限制
  
  // 语言过滤
  if (language !== "all") {
    query += ` language:${language}`;
  }
  
  return query;
}

function formatProjectsForAI(repositories: GitHubRepository[], limit: number, hotness: string): string {
  const limitedRepos = repositories.slice(0, limit);
  
  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return "今天";
    if (diffDays === 1) return "昨天";
    if (diffDays < 7) return `${diffDays}天前`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}周前`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}个月前`;
    return `${Math.floor(diffDays / 365)}年前`;
  };

  const formatNumber = (num: number): string => {
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}k`;
    }
    return num.toString();
  };

  const hotnessLabels = {
    active: "本周活跃AI项目",
    new: "最新AI项目",
    popular: "热门AI项目"
  };

  const projectsText = limitedRepos.map((repo, index) => {
    const pushedAgo = formatTime(repo.pushed_at);
    const createdAgo = formatTime(repo.created_at);
    const stars = formatNumber(repo.stargazers_count);
    const forks = formatNumber(repo.forks_count);
    
    const description = repo.description || "暂无描述";
    const language = repo.language || "未知";
    const topics = repo.topics.length > 0 ? repo.topics.slice(0, 3).join(", ") : "";
    
    let activityInfo = "";
    if (hotness === "active") {
      activityInfo = `最近更新: ${pushedAgo}`;
    } else if (hotness === "new") {
      activityInfo = `创建时间: ${createdAgo}`;
    } else {
      activityInfo = `创建于: ${createdAgo}`;
    }
    
    return `${index + 1}. ${repo.full_name} (⭐${stars}, ${language})
   描述: ${description}
   ${activityInfo} | Forks: ${forks}${topics ? ` | 标签: ${topics}` : ""}
   链接: ${repo.html_url}`;
  }).join("\n\n");

  const summary = `🚀 ${hotnessLabels[hotness as keyof typeof hotnessLabels]}（共 ${limitedRepos.length} 个项目）：\n\n${projectsText}`;
  
  return summary;
}

async function fetchGitHubProjectsFromAPI(
  params: GitHubProjectsParams, 
  token?: string
): Promise<GitHubSearchResponse> {
  const query = buildSearchQuery(params);
  const limit = Math.min(params.limit || 5, 20);
  
  // 构建 GitHub Search API URL
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(limit));
  
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "Nichijou-News-Plugin/1.0",
  };
  
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(8000),
    headers,
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("GitHub Token 无效，请检查配置");
    }
    if (response.status === 403) {
      const resetTime = response.headers.get('x-ratelimit-reset');
      const resetDate = resetTime ? new Date(parseInt(resetTime) * 1000).toLocaleTimeString() : "未知";
      throw new Error(`GitHub API 限流，请稍后再试。重置时间: ${resetDate}`);
    }
    if (response.status === 422) {
      throw new Error("GitHub 搜索查询格式错误");
    }
    throw new Error(`GitHub API 请求失败: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as GitHubSearchResponse;
  return data;
}

export async function fetchGitHubProjects(
  params: GitHubProjectsParams,
  config: Record<string, unknown>
): Promise<{ content: string; isError?: boolean }> {
  try {
    const token = getGitHubToken(config);
    const cacheKey = getCacheKey(params);
    const cacheExpireMinutes = (config.githubCacheMinutes as number) || 30;
    const cacheExpireMs = cacheExpireMinutes * 60 * 1000;

    // 检查缓存
    if (config.enableCache !== false) {
      const cached = githubCache.get(cacheKey);
      if (cached && isValidCache(cached)) {
        const formattedProjects = formatProjectsForAI(
          cached.data.items, 
          params.limit || 5, 
          params.hotness || "active"
        );
        return { 
          content: `${formattedProjects}\n\n📝 数据来自缓存（${Math.floor((Date.now() - cached.timestamp) / 60000)}分钟前）` 
        };
      }
    }

    // 从 API 获取新数据
    const githubData = await fetchGitHubProjectsFromAPI(params, token);
    
    // 检查是否有结果
    if (githubData.total_count === 0) {
      return {
        content: "未找到符合条件的 AI 项目，请尝试调整筛选条件。",
        isError: false,
      };
    }
    
    // 缓存结果
    if (config.enableCache !== false) {
      githubCache.set(cacheKey, {
        data: githubData,
        timestamp: Date.now(),
        expireAfter: cacheExpireMs,
      });
    }

    // 格式化返回给 AI
    const formattedProjects = formatProjectsForAI(
      githubData.items, 
      params.limit || 5, 
      params.hotness || "active"
    );
    
    // 添加搜索统计信息
    const totalCount = githubData.total_count;
    const searchInfo = `\n\n📊 GitHub 搜索统计: 共找到 ${totalCount} 个相关项目`;
    
    return { content: formattedProjects + searchInfo };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // 尝试返回缓存数据作为降级
    const cacheKey = getCacheKey(params);
    const cached = githubCache.get(cacheKey);
    if (cached && config.enableCache !== false) {
      const formattedProjects = formatProjectsForAI(
        cached.data.items, 
        params.limit || 5, 
        params.hotness || "active"
      );
      return { 
        content: `⚠️ 获取最新 GitHub 项目失败（${errorMessage}），显示缓存内容：\n\n${formattedProjects}` 
      };
    }

    return {
      content: `GitHub 项目获取失败: ${errorMessage}`,
      isError: true,
    };
  }
}

// 清理过期缓存的工具函数
export function cleanExpiredGitHubCache(): void {
  const now = Date.now();
  for (const [key, entry] of githubCache.entries()) {
    if (now - entry.timestamp >= entry.expireAfter) {
      githubCache.delete(key);
    }
  }
}