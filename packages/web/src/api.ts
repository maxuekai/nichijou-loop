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
    llm: { baseUrl: string; model: string };
    channels: Record<string, unknown>;
    tokenUsage: { promptTokens: number; completionTokens: number };
  }>("/status"),

  getConfig: () => request<Record<string, unknown>>("/config"),
  updateConfig: (data: Record<string, unknown>) =>
    request("/config", { method: "PUT", body: JSON.stringify(data) }),

  getFamily: () => request<{
    family: { id: string; name: string } | null;
    members: Array<{ id: string; name: string; role: string }>;
  }>("/family"),
  createFamily: (name: string) =>
    request("/family", { method: "POST", body: JSON.stringify({ name }) }),

  addMember: (name: string, role = "member") =>
    request("/members", { method: "POST", body: JSON.stringify({ name, role }) }),
  getMember: (id: string) => request<{ member: Record<string, unknown>; profile: string }>(`/members/${id}`),

  getSoul: () => request<{ content: string }>("/soul"),
  updateSoul: (content: string) =>
    request("/soul", { method: "PUT", body: JSON.stringify({ content }) }),

  chat: (memberId: string, message: string) =>
    request<{ response: string }>("/chat", { method: "POST", body: JSON.stringify({ memberId, message }) }),

  getRoutines: (memberId: string) =>
    request<{ routines: unknown[]; overrides: unknown[] }>(`/routines/${memberId}`),
  getDayPlan: (memberId: string) =>
    request<{ date: string; memberId: string; items: Array<{ title: string; timeSlot?: string }> }>(`/day-plan/${memberId}`),

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

  getWeather: (lat = "39.9", lon = "116.4") =>
    request<{ temp: number | null; tempMax: number | null; tempMin: number | null; weatherCode: number; description: string; location: string }>(`/board/weather?lat=${lat}&lon=${lon}`),

  getWeekSchedule: () =>
    request<{ schedule: Record<string, Record<string, string[]>> }>("/board/week-schedule"),

  getBoardData: () =>
    request<{
      family: { id: string; name: string } | null;
      members: Array<{
        id: string; name: string; role: string;
        profile: string | null;
        dayPlan: { date: string; memberId: string; items: Array<{ id: string; title: string; timeSlot?: string; time?: string; source: string; reminders: Array<{ offsetMinutes: number; message: string; channel: string }> }> };
      }>;
      soul: string;
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

  // --- AI Routine Parsing ---

  parseRoutine: (memberId: string, description: string) =>
    request<{ ok: boolean; routine?: Record<string, unknown>; error?: string }>(
      "/routines/parse",
      { method: "POST", body: JSON.stringify({ memberId, description }) },
    ),

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
    }>>("/plugins"),

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

  avatarUrl: (filename: string) => `${BASE}/avatars/${encodeURIComponent(filename)}`,
};
