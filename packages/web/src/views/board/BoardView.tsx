import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { Solar } from "lunar-javascript";
import { api } from "../../api";

interface SystemInfo {
  hostname: string;
  platform: string;
  cpuCores: number;
  memTotal: number;
  memUsed: number;
  loadAvg: number[];
  processUptime: number;
  nodeVersion: string;
}

// --- Types ---

interface ReminderRule {
  offsetMinutes: number;
  message: string;
  channel: string;
}

interface PlanItem {
  id: string;
  title: string;
  timeSlot?: string;
  time?: string;
  source: string;
  reminders: ReminderRule[];
}

interface BoardMember {
  id: string;
  name: string;
  role: string;
  avatar?: string;
  profile: string | null;
  dayPlan: { date: string; memberId: string; items: PlanItem[] };
}

interface BoardNotification {
  id: number;
  memberId: string;
  memberName: string;
  routineId: string;
  routineTitle: string;
  actionId: string;
  result: string;
  success: boolean;
  executedAt: string;
}

interface WeatherData {
  temp: number | null;
  tempMax: number | null;
  tempMin: number | null;
  weatherCode: number;
  description: string;
  location: string;
}

interface WeekSchedule {
  [date: string]: { [memberName: string]: string[] };
}

interface LunarInfo {
  monthDay: string;
  yearGanZhi: string;
  monthGanZhi: string;
  dayGanZhi: string;
  shengXiao: string;
  jieQi: string;
  festivals: string[];
  solarFestivals: string[];
  yi: string[];
  ji: string[];
}

// --- Constants ---

const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];
const SLOT_ORDER: Record<string, number> = { morning: 0, afternoon: 1, evening: 2 };
const SLOT_LABELS: Record<string, string> = { morning: "上午", afternoon: "下午", evening: "晚上" };

const WEATHER_ICONS: Record<number, string> = {
  0: "clear", 1: "clear", 2: "cloudy", 3: "overcast",
  45: "fog", 48: "fog",
  51: "drizzle", 53: "drizzle", 55: "drizzle",
  61: "rain", 63: "rain", 65: "rain", 66: "rain", 67: "rain",
  71: "snow", 73: "snow", 75: "snow", 77: "snow",
  80: "rain", 81: "rain", 82: "rain",
  85: "snow", 86: "snow",
  95: "thunder", 96: "thunder", 99: "thunder",
};

function getWeatherSymbol(code: number): string {
  const type = WEATHER_ICONS[code] ?? "clear";
  const symbols: Record<string, string> = {
    clear: "☀", cloudy: "⛅", overcast: "☁", fog: "🌫",
    drizzle: "🌦", rain: "🌧", snow: "❄", thunder: "⛈",
  };
  return symbols[type] ?? "☀";
}

function getTimeGreeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 9) return "早安，食早了未";
  if (h >= 9 && h < 11) return "上午好，食茶未";
  if (h >= 11 && h < 14) return "午安，食昼了未";
  if (h >= 14 && h < 18) return "下午好，来食茶";
  if (h >= 18 && h < 22) return "晚上好，食饭了未";
  return "夜深了，早些歇";
}

function getLunarInfo(date: Date): LunarInfo {
  const solar = Solar.fromDate(date);
  const lunar = solar.getLunar();
  return {
    monthDay: `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
    yearGanZhi: lunar.getYearInGanZhi(),
    monthGanZhi: lunar.getMonthInGanZhi(),
    dayGanZhi: lunar.getDayInGanZhi(),
    shengXiao: lunar.getYearShengXiao(),
    jieQi: lunar.getJieQi(),
    festivals: lunar.getFestivals(),
    solarFestivals: solar.getFestivals(),
    yi: lunar.getDayYi(),
    ji: lunar.getDayJi(),
  };
}

function getLunarDayText(date: Date): string {
  const solar = Solar.fromDate(date);
  const lunar = solar.getLunar();
  const festivals = [...lunar.getFestivals(), ...solar.getFestivals()];
  if (festivals.length > 0) return festivals[0]!;
  const jieQi = lunar.getJieQi();
  if (jieQi) return jieQi;
  const dayText = lunar.getDayInChinese();
  if (dayText === "初一") return `${lunar.getMonthInChinese()}月`;
  return dayText;
}

function extractButlerName(soul: string): string {
  const match = soul.match(/你是"([^"]+)"/);
  return match?.[1] ?? "管家";
}

function getCurrentSlot(): string {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

function parseTime(t?: string): number {
  if (!t) return 9999;
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function formatDateShort(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// --- Main Component ---

export function BoardView() {
  const [now, setNow] = useState(new Date());
  const [members, setMembers] = useState<BoardMember[]>([]);
  const [notifications, setNotifications] = useState<BoardNotification[]>([]);
  const [familyName, setFamilyName] = useState("");
  const [familyAvatar, setFamilyAvatar] = useState<string | null>(null);
  const [soul, setSoul] = useState("");
  const [butlerNameConfig, setButlerNameConfig] = useState<string>("");
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weekSchedule, setWeekSchedule] = useState<WeekSchedule>({});
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval>>();

  const loadSysInfo = useCallback(async () => {
    try {
      const data = await api.getSystemInfo();
      setSysInfo(data);
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : "系统信息加载失败");
    }
  }, []);

  useEffect(() => {
    loadBoardData();
    loadWeather();
    loadWeekSchedule();
    loadSysInfo();

    tickRef.current = setInterval(() => setNow(new Date()), 1000);
    const dataInterval = setInterval(loadBoardData, 5 * 60 * 1000);
    const weatherInterval = setInterval(loadWeather, 30 * 60 * 1000);
    const weekInterval = setInterval(loadWeekSchedule, 10 * 60 * 1000);
    const sysInterval = setInterval(loadSysInfo, 30 * 1000);

    return () => {
      clearInterval(tickRef.current);
      clearInterval(dataInterval);
      clearInterval(weatherInterval);
      clearInterval(weekInterval);
      clearInterval(sysInterval);
    };
  }, []);

  async function loadBoardData() {
    try {
      setBoardError(null);
      const data = await api.getBoardData();
      setFamilyName(data.family?.name ?? "");
      setFamilyAvatar(data.family?.avatar ?? null);
      setMembers(data.members);
      setSoul(data.soul);
      setNotifications(data.notifications ?? []);
      const cfg = await api.getConfig();
      const configuredName = typeof cfg.butlerName === "string" ? cfg.butlerName.trim() : "";
      setButlerNameConfig(configuredName);
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : "看板数据加载失败");
    }
  }

  async function loadWeather() {
    try {
      const data = await api.getWeather();
      setWeather(data);
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : "天气数据加载失败");
    }
  }

  async function loadWeekSchedule() {
    try {
      const data = await api.getWeekSchedule();
      setWeekSchedule(data.schedule);
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : "周计划加载失败");
    }
  }

  const timeStr = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const dateDay = now.getDate();
  const dateMonth = now.getMonth() + 1;
  const weekday = WEEKDAY_CN[now.getDay()];
  const butlerName = butlerNameConfig || extractButlerName(soul);
  const greeting = getTimeGreeting();
  const currentSlot = getCurrentSlot();

  const lunarInfo = useMemo(() => getLunarInfo(now), [now.toDateString()]);

  const allItems: Array<PlanItem & { memberName: string }> = [];
  for (const m of members) {
    for (const item of m.dayPlan.items) {
      allItems.push({ ...item, memberName: m.name });
    }
  }

  const grouped: Record<string, Array<PlanItem & { memberName: string }>> = { morning: [], afternoon: [], evening: [], other: [] };
  for (const item of allItems) {
    const slot = item.timeSlot && SLOT_ORDER[item.timeSlot] !== undefined ? item.timeSlot : "other";
    grouped[slot]!.push(item);
  }
  for (const key of Object.keys(grouped)) {
    grouped[key]!.sort((a, b) => parseTime(a.time) - parseTime(b.time));
  }

  const upcomingReminders: Array<{ time: string; message: string; memberName: string; minutesLeft: number }> = [];
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const item of allItems) {
    if (!item.time || !item.reminders) continue;
    const itemMinutes = parseTime(item.time);
    for (const r of item.reminders) {
      const triggerMinute = itemMinutes - r.offsetMinutes;
      const diff = triggerMinute - nowMinutes;
      if (diff > -30) {
        upcomingReminders.push({
          time: `${String(Math.floor(triggerMinute / 60)).padStart(2, "0")}:${String(triggerMinute % 60).padStart(2, "0")}`,
          message: r.message,
          memberName: item.memberName,
          minutesLeft: diff,
        });
      }
    }
  }
  upcomingReminders.sort((a, b) => a.minutesLeft - b.minutesLeft);

  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  const weekDates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    weekDates.push(d);
  }

  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const allFestivals = [...lunarInfo.festivals, ...lunarInfo.solarFestivals];

  return (
    <div className="min-h-screen bg-[#1a1816] text-[#e8e0d4] selection:bg-amber-800/40">
      <div className="max-w-[1400px] mx-auto px-8 py-6 min-h-screen flex flex-col">

        {/* ===== Header ===== */}
        <header className="flex items-start justify-between mb-8">
          <div className="flex items-end gap-8">
            {/* Date block */}
            <div className="flex items-end gap-4">
              <span className="text-8xl font-extralight tracking-tighter tabular-nums leading-none text-[#c8b89a]">
                {dateDay}
              </span>
              <div className="pb-2">
                <p className="text-base text-[#8a7e6d] tracking-widest">{dateMonth}月 · 星期{weekday}</p>
                <p className="text-sm text-[#a89880] mt-1">
                  农历{lunarInfo.monthDay}
                  {lunarInfo.jieQi && <span className="ml-2 text-[#c8a55a]">【{lunarInfo.jieQi}】</span>}
                </p>
                <p className="text-xs text-[#6a6054] mt-0.5">
                  {lunarInfo.yearGanZhi}年 {lunarInfo.monthGanZhi}月 {lunarInfo.dayGanZhi}日 · {lunarInfo.shengXiao}年
                </p>
              </div>
            </div>

            {/* Greeting + Festivals */}
            <div className="pb-2">
              <p className="text-lg text-[#a89880] tracking-wide">{greeting}</p>
              {allFestivals.length > 0 && (
                <p className="text-sm text-[#c8a55a] mt-1">{allFestivals.join(" · ")}</p>
              )}
              {familyName && (
                <p className="text-sm text-[#6a6054] mt-1 flex items-center gap-2">
                  {familyAvatar ? (
                    <img src={api.avatarUrl(familyAvatar)} alt={familyName} className="w-5 h-5 rounded-full object-cover" />
                  ) : null}
                  {butlerName}为{familyName}守护每一天
                </p>
              )}
            </div>
          </div>

          <div className="flex items-start gap-8">
            {/* Weather */}
            {weather && weather.temp !== null && (
              <div className="text-right">
                <div className="flex items-center justify-end gap-3">
                  <span className="text-3xl leading-none">{getWeatherSymbol(weather.weatherCode)}</span>
                  <span className="text-4xl font-extralight tabular-nums text-[#c8b89a]">{weather.temp}°</span>
                </div>
                <p className="text-sm text-[#6a6054] mt-1">
                  {weather.location && <span className="text-[#8a7e6d]">{weather.location} · </span>}
                  {weather.description} · {weather.tempMin}° / {weather.tempMax}°
                </p>
              </div>
            )}

            {/* Clock */}
            <div className="text-right">
              <p className="text-5xl font-extralight tabular-nums tracking-tight text-[#c8b89a] leading-none">
                {timeStr}
              </p>
              <Link to="/admin" className="text-xs text-[#4a4438] hover:text-[#8a7e6d] mt-2 inline-block tracking-widest">
                管理面板
              </Link>
            </div>
          </div>
        </header>
        {boardError && (
          <div className="mb-4 text-sm text-red-300">
            数据刷新异常：{boardError}
          </div>
        )}

        {/* ===== 宜忌 Bar ===== */}
        {(lunarInfo.yi.length > 0 || lunarInfo.ji.length > 0) && (
          <div className="flex items-center gap-6 mb-6 py-3 px-5 rounded-xl bg-[#231f1c] border border-[#2e2a26]">
            {lunarInfo.yi.length > 0 && (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-sm font-medium text-[#6aaa6a] flex-shrink-0">宜</span>
                <span className="text-sm text-[#8a7e6d] truncate">{lunarInfo.yi.slice(0, 6).join(" · ")}</span>
              </div>
            )}
            {lunarInfo.ji.length > 0 && (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-sm font-medium text-[#aa6a6a] flex-shrink-0">忌</span>
                <span className="text-sm text-[#8a7e6d] truncate">{lunarInfo.ji.slice(0, 6).join(" · ")}</span>
              </div>
            )}
          </div>
        )}

        {/* ===== Main Grid ===== */}
        <div className="flex-1 grid gap-6" style={{ gridTemplateColumns: "260px 1fr 300px", gridTemplateRows: "1fr auto" }}>

          {/* --- Left: Member Cards --- */}
          <div className="space-y-3 overflow-auto pr-2" style={{ maxHeight: "calc(100vh - 280px)" }}>
            <p className="text-xs text-[#5a5448] tracking-[0.2em] mb-2">家人 · {members.length}</p>
            {members.map((m) => (
              <div key={m.id} className="flex items-center gap-3 bg-[#231f1c] rounded-xl px-4 py-3 border border-[#2e2a26]">
                {m.avatar ? (
                  <img src={api.avatarUrl(m.avatar)} alt={m.name} className="w-11 h-11 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <div className="w-11 h-11 rounded-full bg-[#3a3530] flex items-center justify-center text-[#c8b89a] text-base font-medium flex-shrink-0">
                    {m.name.charAt(0)}
                  </div>
                )}
                <p className="text-base font-medium text-[#ddd5c8]">{m.name}</p>
              </div>
            ))}
            {members.length === 0 && (
              <p className="text-sm text-[#4a4438] text-center py-8">暂无成员</p>
            )}
          </div>

          {/* --- Center: Today Timeline --- */}
          <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 280px)" }}>
            <p className="text-xs text-[#5a5448] tracking-[0.2em] mb-5">
              今日安排 · {allItems.length} 项
            </p>
            <div className="space-y-7">
              {(["morning", "afternoon", "evening"] as const).map((slot) => {
                const items = grouped[slot]!;
                const isCurrent = slot === currentSlot;
                return (
                  <div key={slot}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-2 h-2 rounded-full ${isCurrent ? "bg-[#c8a55a]" : "bg-[#3a3530]"}`} />
                      <p className={`text-sm tracking-wider ${isCurrent ? "text-[#c8a55a] font-medium" : "text-[#6a6054]"}`}>
                        {SLOT_LABELS[slot]}
                      </p>
                      {isCurrent && <span className="text-xs text-[#c8a55a]/60">当前</span>}
                    </div>
                    {items.length > 0 ? (
                      <div className="space-y-2.5 ml-5 border-l border-[#2e2a26] pl-5">
                        {items.map((item, i) => {
                          const isPast = !isCurrent && SLOT_ORDER[slot]! < SLOT_ORDER[currentSlot]!;
                          return (
                            <div key={`${item.id}-${i}`} className={`flex items-start gap-4 ${isPast ? "opacity-40" : ""}`}>
                              {item.time ? (
                                <span className="text-sm tabular-nums text-[#8a7e6d] w-14 flex-shrink-0 pt-0.5">{item.time}</span>
                              ) : (
                                <span className="w-14 flex-shrink-0" />
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="text-base text-[#ddd5c8]">{item.title}</p>
                                <span className="inline-block text-xs text-[#5a5448] mt-0.5">{item.memberName}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-[#3a3530] ml-5 pl-5">——</p>
                    )}
                  </div>
                );
              })}
              {grouped.other!.length > 0 && (
                <div>
                  <p className="text-sm text-[#5a5448] tracking-wider mb-3 flex items-center gap-3">
                    <span className="w-2 h-2 rounded-full bg-[#3a3530]" />
                    其他
                  </p>
                  <div className="space-y-2.5 ml-5 border-l border-[#2e2a26] pl-5">
                    {grouped.other!.map((item, i) => (
                      <div key={`other-${i}`} className="flex items-start gap-4">
                        <span className="w-14 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-base text-[#ddd5c8]">{item.title}</p>
                          <span className="inline-block text-xs text-[#5a5448] mt-0.5">{item.memberName}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* --- Right Column: Week + Reminders --- */}
          <div className="space-y-6 overflow-auto" style={{ maxHeight: "calc(100vh - 280px)" }}>
            {/* Week Calendar */}
            <div>
              <p className="text-xs text-[#5a5448] tracking-[0.2em] mb-3">本周日历</p>
              <div className="grid grid-cols-7 gap-1">
                {weekDates.map((d, i) => {
                  const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                  const isToday = ds === todayStr;
                  const dayData = weekSchedule[ds] ?? {};
                  const totalItems = Object.values(dayData).reduce((sum, arr) => sum + arr.length, 0);
                  const lunarDay = getLunarDayText(d);

                  return (
                    <div
                      key={ds}
                      className={`text-center py-2 rounded-lg ${isToday ? "bg-[#c8a55a]/10 border border-[#c8a55a]/20" : "bg-[#231f1c]"}`}
                    >
                      <p className={`text-xs ${i === 0 || i === 6 ? "text-[#8a6a5a]" : "text-[#6a6054]"}`}>
                        {WEEKDAY_CN[i]}
                      </p>
                      <p className={`text-base tabular-nums ${isToday ? "text-[#c8a55a] font-medium" : "text-[#8a7e6d]"}`}>
                        {d.getDate()}
                      </p>
                      <p className={`text-[10px] mt-0.5 ${isToday ? "text-[#c8a55a]/70" : "text-[#5a5448]"}`}>
                        {lunarDay}
                      </p>
                      {totalItems > 0 && (
                        <div className="flex justify-center gap-0.5 mt-1">
                          {Object.keys(dayData).map((name) => (
                            <span key={name} className={`w-1.5 h-1.5 rounded-full ${isToday ? "bg-[#c8a55a]" : "bg-[#5a5448]"}`} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Week detail list */}
              <div className="mt-3 space-y-1.5">
                {weekDates.map((d) => {
                  const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                  const dayData = weekSchedule[ds] ?? {};
                  const entries = Object.entries(dayData);
                  if (entries.length === 0) return null;
                  const isToday = ds === todayStr;

                  return (
                    <div key={ds} className={`text-sm p-2 rounded-lg ${isToday ? "bg-[#c8a55a]/5" : ""}`}>
                      <span className={`tabular-nums ${isToday ? "text-[#c8a55a]" : "text-[#6a6054]"}`}>
                        {formatDateShort(d)}
                      </span>
                      {entries.map(([name, titles]) => (
                        <span key={name} className="text-[#8a7e6d] ml-2">
                          {name}: {titles.slice(0, 2).join("、")}{titles.length > 2 ? `…+${titles.length - 2}` : ""}
                        </span>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Upcoming Reminders */}
            <div>
              <p className="text-xs text-[#5a5448] tracking-[0.2em] mb-3">待办提醒</p>
              {upcomingReminders.length > 0 ? (
                <div className="space-y-2">
                  {upcomingReminders.slice(0, 5).map((r, i) => (
                    <div
                      key={i}
                      className={`bg-[#231f1c] rounded-lg p-3.5 border border-[#2e2a26] ${r.minutesLeft <= 0 ? "opacity-40" : ""}`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-[#6a6054]">{r.memberName}</span>
                        <span className="text-xs tabular-nums text-[#8a7e6d]">{r.time}</span>
                      </div>
                      <p className="text-sm text-[#c8b89a]">{r.message}</p>
                      {r.minutesLeft > 0 && (
                        <p className="text-xs text-[#c8a55a]/60 mt-1">
                          {r.minutesLeft >= 60
                            ? `${Math.floor(r.minutesLeft / 60)}小时${r.minutesLeft % 60 > 0 ? `${r.minutesLeft % 60}分钟` : ""}后`
                            : `${r.minutesLeft}分钟后`}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[#3a3530] text-center py-4">暂无提醒</p>
              )}
            </div>

            {/* Recent Notifications */}
            <div>
              <p className="text-xs text-[#5a5448] tracking-[0.2em] mb-3">最近通知</p>
              {notifications.length > 0 ? (
                <div className="space-y-2">
                  {notifications.slice(0, 8).map((n) => (
                    <div key={n.id} className="bg-[#231f1c] rounded-lg p-3.5 border border-[#2e2a26]">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-[#8a7e6d]">{n.memberName} · {n.routineTitle}</span>
                        <span className="text-[11px] text-[#6a6054]">
                          {new Date(n.executedAt).toLocaleString("zh-CN", {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })}
                        </span>
                      </div>
                      <p className="text-sm text-[#c8b89a] line-clamp-2">{n.result || "已执行"}</p>
                      <p className={`text-[11px] mt-1 ${n.success ? "text-[#6aaa6a]" : "text-[#aa6a6a]"}`}>
                        {n.success ? "执行成功" : "执行失败"}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[#3a3530] text-center py-4">暂无通知</p>
              )}
            </div>
          </div>

          {/* --- Bottom Bar --- */}
          <div className="col-span-3 border-t border-[#2e2a26] pt-3 pb-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <p className="text-xs text-[#5a5448] tracking-[0.2em]">本周菜单</p>
                <span className="text-xs text-[#3a3530]">· 通过微信发送菜品给{butlerName}来建立家庭菜谱</span>
              </div>
              {sysInfo && (
                <div className="flex items-center gap-4 text-[11px] text-[#5a5448]">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#6aaa6a] animate-pulse" />
                    {sysInfo.hostname}
                  </span>
                  <span>
                    内存 {Math.round((sysInfo.memUsed / sysInfo.memTotal) * 100)}%
                  </span>
                  <span>
                    负载 {sysInfo.loadAvg[0]?.toFixed(1)}
                  </span>
                  <span>
                    运行 {sysInfo.processUptime >= 86400
                      ? `${Math.floor(sysInfo.processUptime / 86400)}天`
                      : sysInfo.processUptime >= 3600
                        ? `${Math.floor(sysInfo.processUptime / 3600)}小时`
                        : `${Math.floor(sysInfo.processUptime / 60)}分钟`}
                  </span>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
