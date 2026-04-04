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
};
