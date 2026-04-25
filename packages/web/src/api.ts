import type { ConversationLogWithMedia, MediaContent, ProcessedMediaInfo, SystemLogEntry } from "@nichijou/shared";

const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as Record<string, string>).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getStatus: () => request<{
    setupCompleted: boolean;
    llm: { id?: string; name?: string; provider?: string; baseUrl: string; model: string };
    channels: Record<string, unknown>;
    tokenUsage: { promptTokens: number; completionTokens: number };
  }>("/status"),

  getConfig: () => request<Record<string, unknown>>("/config"),
  updateConfig: (data: Record<string, unknown>) =>
    request("/config", { method: "PUT", body: JSON.stringify(data) }),

  // Models API
  getModels: () => request<{
    models: Array<{
      id: string;
      name: string;
      provider: string;
      baseUrl: string;
      apiKey: string;
      model: string;
      timeout?: number;
      thinkingMode?: boolean;
      enabled: boolean;
      isDefault: boolean;
      createdAt: string;
      lastUsedAt?: string;
    }>;
    activeModelId: string;
  }>("/models"),
  addModel: (config: {
    name: string;
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    timeout?: number;
    thinkingMode?: boolean;
    enabled: boolean;
    isDefault: boolean;
  }) => request<{ ok: boolean; id: string }>("/models", { method: "POST", body: JSON.stringify(config) }),
  updateModel: (id: string, updates: Partial<{
    name: string;
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    timeout?: number;
    thinkingMode?: boolean;
    enabled: boolean;
    isDefault: boolean;
  }>) => request<{ ok: boolean }>(`/models/${id}`, { method: "PUT", body: JSON.stringify(updates) }),
  deleteModel: (id: string) => request<{ ok: boolean }>(`/models/${id}`, { method: "DELETE" }),
  testModel: (config: {
    id: string;
    name: string;
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    timeout?: number;
    thinkingMode?: boolean;
    enabled: boolean;
    isDefault: boolean;
    createdAt: string;
    lastUsedAt?: string;
  }) => request<{ success: boolean; error?: string }>(`/models/${config.id}/test`, { method: "POST" }),
  activateModel: (id: string) => request<{ ok: boolean }>(`/models/${id}/activate`, { method: "PUT" }),

  getFamily: () => request<{
    family: { id: string; name: string; avatar?: string; homeCity?: string; homeAdcode?: string } | null;
    members: Array<{ id: string; name: string; role: string }>;
  }>("/family"),
  createFamily: (data: { name: string; homeCity?: string; homeAdcode?: string }) =>
    request("/family", { method: "POST", body: JSON.stringify(data) }),
  updateFamily: (data: { name?: string; avatar?: string; homeCity?: string; homeAdcode?: string }) =>
    request<{ ok: boolean; family: { id: string; name: string; avatar?: string; homeCity?: string; homeAdcode?: string } }>("/family", { method: "PUT", body: JSON.stringify(data) }),

  addMember: (name: string, role = "member") =>
    request("/members", { method: "POST", body: JSON.stringify({ name, role }) }),
  updateMember: (id: string, data: { name?: string; profile?: string; wechatNotifyEnabled?: boolean }) =>
    request<{ ok: boolean }>(`/members/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  getMember: (id: string) => request<{ member: Record<string, unknown>; profile: string }>(`/members/${id}`),

  getSoul: () => request<{ content: string }>("/soul"),
  updateSoul: (content: string) =>
    request("/soul", { method: "PUT", body: JSON.stringify({ content }) }),

  chat: (memberId: string, message: string) =>
    request<{ response: string }>("/chat", { method: "POST", body: JSON.stringify({ memberId, message }) }),

  getRoutines: (memberId: string) =>
    request<{ routines: unknown[] }>(`/routines/${memberId}`),
  getFamilyRoutines: () =>
    request<{ routines: unknown[] }>("/family/routines"),
  upsertFamilyRoutine: (routineId: string, data: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/family/routines/${routineId}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteFamilyRoutine: (routineId: string) =>
    request<{ ok: boolean }>(`/family/routines/${routineId}`, { method: "DELETE" }),
  getDaySchedule: (memberId: string) =>
    request<{ date: string; memberId: string; items: Array<{ title: string; timeSlot?: string }> }>(`/day-schedule/${memberId}`),

  testLLM: (config: { baseUrl: string; apiKey: string; model: string }) =>
    request<{ ok: boolean; error?: string }>("/setup/test-llm", { method: "POST", body: JSON.stringify(config) }),

  completeSetup: () => request("/setup/complete", { method: "POST" }),

  getSystemInfo: () =>
    request<{
      hostname: string;
      platform: string;
      osRelease: string;
      arch: string;
      cpuModel: string;
      cpuCores: number;
      memTotal: number;
      memUsed: number;
      memFree: number;
      diskTotal: number;
      diskUsed: number;
      diskFree: number;
      loadAvg: number[];
      sysUptime: number;
      processUptime: number;
      nodeVersion: string;
      pid: number;
    }>("/system-info"),

  getLogs: async (): Promise<ConversationLogWithMedia[]> => {
    const response = await request<{ logs: ConversationLogWithMedia[] }>("/logs");
    return response.logs;
  },

  getSystemLogs: async (kind: "runtime" | "error", limit = 200): Promise<SystemLogEntry[]> => {
    const response = await request<{ logs: SystemLogEntry[] }>(`/logs/system?kind=${kind}&limit=${limit}`);
    return response.logs;
  },

  getMediaFile: (filePath: string) => `${BASE}/media/${encodeURIComponent(filePath)}`,

  getThumbnail: (filePath: string, size: "small" | "medium" | "large" = "medium") =>
    `${BASE}/media/${encodeURIComponent(filePath)}/thumbnail?size=${size}`,

  downloadMedia: async (filePath: string, filename?: string): Promise<void> => {
    const response = await fetch(`${BASE}/media/${encodeURIComponent(filePath)}`);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || filePath.split("/").pop() || "download";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  },

  getWeather: () =>
    request<{ temp: number | null; tempMax: number | null; tempMin: number | null; weatherCode: number; description: string; location: string }>("/board/weather"),

  getWeekSchedule: () =>
    request<{ schedule: Record<string, Record<string, string[]>> }>("/board/week-schedule"),

  getBoardData: () =>
    request<{
      family: { id: string; name: string; avatar?: string } | null;
      members: Array<{
        id: string; name: string; role: string;
        profile: string | null;
        daySchedule: { date: string; memberId: string; items: Array<{ id: string; title: string; timeSlot?: string; time?: string; source: string; reminders: Array<{ offsetMinutes: number; message: string; channel: string }> }> };
      }>;
      soul: string;
      notifications: Array<{
        id: number;
        memberId: string;
        memberName: string;
        routineId: string;
        routineTitle: string;
        actionId: string;
        result: string;
        success: boolean;
        executedAt: string;
      }>;
    }>("/board/data"),

  // --- Reminders ---

  getReminders: (memberId?: string) =>
    request<Array<{ id: string; memberId: string; message: string; triggerAt: string; channel: string; done: boolean; createdAt: string }>>(
      memberId ? `/reminders?memberId=${memberId}` : "/reminders",
    ),

  createReminder: (data: { memberId: string; message: string; triggerAt: string; channel?: string }) =>
    request<{ id: string }>("/reminders", { method: "POST", body: JSON.stringify(data) }),

  updateReminder: (id: string, data: { message?: string; triggerAt?: string; channel?: string }) =>
    request<{ ok: boolean }>(`/reminders/${id}`, { method: "PUT", body: JSON.stringify(data) }),

  deleteReminder: (id: string) =>
    request<{ ok: boolean }>(`/reminders/${id}`, { method: "DELETE" }),

  getActionLogs: (memberId: string, limit = 20) =>
    request<Array<{ id: number; memberId: string; routineId: string; actionId: string; result: string; success: boolean; executedAt: string }>>(
      `/action-logs/${memberId}?limit=${limit}`,
    ),
  triggerRoutine: (memberId: string, routineId: string) =>
    request<{ ok: boolean; executedActions?: number; error?: string }>(
      `/members/${memberId}/routines/${routineId}/trigger`,
      { method: "POST" },
    ),

  // --- Tools ---

  getAllTools: () =>
    request<Array<{ source: string; name: string; description: string; parameters: Record<string, unknown> }>>("/tools"),

  executeTool: (toolName: string, params: Record<string, unknown>) =>
    request<{ content: string; isError?: boolean }>(`/tools/${encodeURIComponent(toolName)}/execute`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  // --- Context ---

  clearMemberContext: (memberId: string) =>
    request<{ ok: boolean }>(`/members/${memberId}/clear-context`, { method: "POST" }),

  clearAllContext: () =>
    request<{ ok: boolean }>("/clear-context", { method: "POST" }),

  // --- Plugins ---

  getPluginTools: () =>
    request<Array<{ pluginId: string; pluginName: string; toolName: string; description: string }>>("/plugins/tools"),

  getPlugins: () =>
    request<Array<{
      id: string;
      name: string;
      description: string;
      version: string;
      enabled: boolean;
      tools: Array<{ name: string; description: string }>;
      configSchema: Record<string, { type: string; description: string; required?: boolean; default?: unknown }> | null;
    }>>("/plugins"),

  getPluginConfig: (pluginId: string) =>
    request<{
      config: Record<string, unknown>;
      configSchema: Record<string, { type: string; description: string; required?: boolean; default?: unknown }> | null;
    }>(`/plugins/${pluginId}/config`),

  updatePluginConfig: (pluginId: string, config: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/plugins/${pluginId}/config`, { method: "PUT", body: JSON.stringify(config) }),

  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    request<{ ok: boolean; error?: string }>(`/plugins/${pluginId}/enabled`, { method: "PUT", body: JSON.stringify({ enabled }) }),

  // --- Geo ---

  detectLocation: () =>
    request<{ lat: string; lon: string; name: string; error?: string }>("/geo/detect"),

  // --- Avatars ---

  uploadAvatar: async (memberId: string, file: File): Promise<{ ok: boolean; avatar?: string }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = reader.result as string;
          const res = await fetch(`${BASE}/members/${memberId}/avatar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data, filename: file.name }),
          });
          resolve(await res.json());
        } catch (e) { reject(e); }
      };
      reader.readAsDataURL(file);
    });
  },

  uploadButlerAvatar: async (file: File): Promise<{ ok: boolean; avatar?: string }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = reader.result as string;
          const res = await fetch(`${BASE}/butler/avatar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data, filename: file.name }),
          });
          resolve(await res.json());
        } catch (e) { reject(e); }
      };
      reader.readAsDataURL(file);
    });
  },

  getButlerAvatar: () =>
    request<{ avatar: string | null }>("/butler/avatar"),

  uploadFamilyAvatar: async (file: File): Promise<{ ok: boolean; avatar?: string }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = reader.result as string;
          const res = await fetch(`${BASE}/family/avatar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data, filename: file.name }),
          });
          resolve(await res.json());
        } catch (e) { reject(e); }
      };
      reader.readAsDataURL(file);
    });
  },

  getFamilyAvatar: () =>
    request<{ avatar: string | null }>("/family/avatar"),

  avatarUrl: (filename: string) => `${BASE}/avatars/${encodeURIComponent(filename)}`,
};
