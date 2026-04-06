import { definePlugin } from "@nichijou/plugin-sdk";

const WMO_DESCRIPTIONS: Record<number, string> = {
  0: "晴", 1: "大部晴朗", 2: "局部多云", 3: "多云",
  45: "雾", 48: "雾凇", 51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "大冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "阵雨", 81: "中阵雨", 82: "大阵雨",
  85: "小阵雪", 86: "大阵雪", 95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹",
};

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function describeCode(code: number): string {
  return WMO_DESCRIPTIONS[code] ?? "未知";
}

interface OpenMeteoResponse {
  current?: { temperature_2m: number; weather_code: number };
  daily?: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    weather_code: number[];
    precipitation_probability_max?: number[];
    sunrise?: string[];
    sunset?: string[];
  };
}

async function fetchOpenMeteo(lat: string, lon: string, forecastDays: number, includeCurrent: boolean): Promise<OpenMeteoResponse> {
  const parts = [
    `latitude=${lat}`,
    `longitude=${lon}`,
    `daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset`,
    `timezone=auto`,
    `forecast_days=${forecastDays}`,
  ];
  if (includeCurrent) {
    parts.push("current=temperature_2m,weather_code");
  }
  const url = `https://api.open-meteo.com/v1/forecast?${parts.join("&")}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`Open-Meteo API error: ${resp.status}`);
  return resp.json() as Promise<OpenMeteoResponse>;
}

async function reverseGeocode(lat: string, lon: string): Promise<string> {
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=zh&zoom=10`,
      { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "NichijouLoop/1.0" } },
    );
    const json = await resp.json() as { address?: { city?: string; town?: string; county?: string; state?: string; suburb?: string; district?: string } };
    const addr = json.address;
    if (addr) return addr.city || addr.town || addr.county || addr.district || addr.suburb || addr.state || "";
  } catch { /* optional */ }
  return "";
}

export default definePlugin({
  id: "weather",
  name: "天气助手",
  description: "天气查询、多日天气预报，支持 1-16 天范围查询",
  version: "0.1.0",

  tools: [
    {
      name: "weather_now",
      description: "获取当前实时天气，返回气温、天气描述和城市名。",
      parameters: {
        type: "object",
        properties: {
          lat: { type: "string", description: "纬度" },
          lon: { type: "string", description: "经度" },
        },
      },
      execute: async (params) => {
        const lat = (params.lat as string) || "39.9";
        const lon = (params.lon as string) || "116.4";

        try {
          const data = await fetchOpenMeteo(lat, lon, 1, true);
          const location = await reverseGeocode(lat, lon);
          const temp = Math.round(data.current!.temperature_2m);
          const desc = describeCode(data.current!.weather_code);
          const tMax = Math.round(data.daily!.temperature_2m_max[0]!);
          const tMin = Math.round(data.daily!.temperature_2m_min[0]!);
          const precip = data.daily!.precipitation_probability_max?.[0] ?? 0;

          const lines = [
            `📍 ${location || "当前位置"}`,
            `🌡 ${temp}°C · ${desc}`,
            `↕ ${tMin}° / ${tMax}°`,
          ];
          if (precip > 0) lines.push(`🌧 降水概率 ${precip}%`);

          return { content: lines.join("\n") };
        } catch (err) {
          return { content: `获取天气失败: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
    {
      name: "weather_forecast",
      description:
        "获取天气预报。支持查询今天、明天、或未来最多16天的天气。" +
        "参数 startDay: 0=今天 1=明天 2=后天…；days: 查询天数 1-16。" +
        "例如：查明天天气用 startDay=1,days=1；查未来一周用 startDay=1,days=7。",
      parameters: {
        type: "object",
        properties: {
          lat: { type: "string", description: "纬度" },
          lon: { type: "string", description: "经度" },
          days: { type: "number", description: "预报天数，1-16，默认 1" },
          startDay: { type: "number", description: "从第几天开始，0=今天 1=明天，默认 0" },
        },
      },
      execute: async (params) => {
        const lat = (params.lat as string) || "39.9";
        const lon = (params.lon as string) || "116.4";
        const days = Math.min(16, Math.max(1, (params.days as number) || 1));
        const startDay = Math.max(0, (params.startDay as number) || 0);
        const forecastDays = startDay + days;

        if (forecastDays > 16) {
          return { content: "最多支持16天预报，请调整 startDay 和 days 参数", isError: true };
        }

        try {
          const data = await fetchOpenMeteo(lat, lon, forecastDays, false);
          const daily = data.daily!;
          const location = await reverseGeocode(lat, lon);

          const lines: string[] = [];
          if (location) lines.push(`📍 ${location} 天气预报`);
          lines.push("");

          for (let i = startDay; i < startDay + days && i < daily.time.length; i++) {
            const date = daily.time[i]!;
            const dow = WEEKDAY_NAMES[new Date(date + "T00:00:00").getDay()]!;
            const tMax = Math.round(daily.temperature_2m_max[i]!);
            const tMin = Math.round(daily.temperature_2m_min[i]!);
            const desc = describeCode(daily.weather_code[i]!);
            const precip = daily.precipitation_probability_max?.[i] ?? 0;
            const sunrise = daily.sunrise?.[i]?.slice(11, 16) ?? "";
            const sunset = daily.sunset?.[i]?.slice(11, 16) ?? "";

            let dayLabel = `${date} ${dow}`;
            if (i === 0) dayLabel += "（今天）";
            else if (i === 1) dayLabel += "（明天）";
            else if (i === 2) dayLabel += "（后天）";

            let line = `${dayLabel}：${desc}，${tMin}°~${tMax}°C`;
            if (precip > 0) line += `，降水${precip}%`;
            if (sunrise && sunset) line += `，日出${sunrise} 日落${sunset}`;
            lines.push(line);
          }

          return { content: lines.join("\n") };
        } catch (err) {
          return { content: `获取天气预报失败: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ],

  dashboardWidgets: [
    { id: "weather-card", name: "天气卡片", component: "WeatherCard", defaultSize: "small" },
  ],
});
