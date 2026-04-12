import { definePlugin } from "@nichijou/plugin-sdk";

interface AmapLive {
  province: string;
  city: string;
  adcode: string;
  weather: string;
  temperature: string;
  winddirection: string;
  windpower: string;
  humidity: string;
  reporttime: string;
}

interface AmapCast {
  date: string;
  week: string;
  dayweather: string;
  nightweather: string;
  daytemp: string;
  nighttemp: string;
  daywind: string;
  nightwind: string;
  daypower: string;
  nightpower: string;
}

interface AmapForecast {
  city: string;
  adcode: string;
  province: string;
  reporttime: string;
  casts: AmapCast[];
}

interface AmapWeatherResp {
  status: string;
  count: string;
  info: string;
  infocode: string;
  lives?: AmapLive[];
  forecasts?: AmapForecast[];
}

interface AmapGeoResp {
  status: string;
  geocodes?: { adcode: string; city: string }[];
}

const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function resolveKey(params: Record<string, unknown>): string {
  const key = (params.amapKey as string) || process.env.AMAP_API_KEY || "";
  if (!key) throw new Error("高德地图 API Key 未配置。请在管理后台「插件管理」中配置天气插件的 amapKey，或设置环境变量 AMAP_API_KEY。");
  return key;
}

async function resolveAdcode(city: string, key: string): Promise<string> {
  if (/^\d{6}$/.test(city)) return city;

  const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(city)}&key=${key}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`高德地理编码请求失败: ${resp.status}`);
  const data = (await resp.json()) as AmapGeoResp;
  if (data.status !== "1" || !data.geocodes?.length) {
    throw new Error(`无法识别城市「${city}」，请使用城市名称或 6 位行政区划编码 (adcode)`);
  }
  return data.geocodes[0]!.adcode;
}

async function fetchWeather(adcode: string, key: string, extensions: "base" | "all"): Promise<AmapWeatherResp> {
  const url = `https://restapi.amap.com/v3/weather/weatherInfo?city=${adcode}&key=${key}&extensions=${extensions}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`高德天气 API 请求失败: ${resp.status}`);
  const data = (await resp.json()) as AmapWeatherResp;
  if (data.status !== "1") {
    throw new Error(`高德天气查询失败: ${data.info} (${data.infocode})`);
  }
  return data;
}

export default definePlugin({
  id: "weather",
  name: "天气助手",
  description: "基于高德地图 API 的天气查询，支持实况天气和未来 3 天预报",
  version: "0.2.0",

  configSchema: {
    amapKey: {
      type: "string",
      description: "高德地图 Web 服务 API Key",
      required: true,
    },
  },

  tools: [
    {
      name: "weather_now",
      description:
        "获取指定城市的实况天气，返回气温、天气状况、风向风力、湿度。" +
        "参数 city 可以是城市名（如「深圳」「北京市」）或 6 位行政区划编码 (adcode)。",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名称或 adcode，例如 \"深圳\" 或 \"440300\"" },
        },
        required: ["city"],
      },
      execute: async (params) => {
        try {
          const key = resolveKey(params);
          const city = (params.city as string) || "北京";
          const adcode = await resolveAdcode(city, key);
          const data = await fetchWeather(adcode, key, "base");
          const live = data.lives?.[0];
          if (!live) return { content: "未获取到实况天气数据", isError: true };

          const lines = [
            `📍 ${live.province} ${live.city}`,
            `🌡 ${live.temperature}°C · ${live.weather}`,
            `💨 ${live.winddirection}风 ${live.windpower}级`,
            `💧 湿度 ${live.humidity}%`,
            `🕐 数据发布: ${live.reporttime}`,
          ];
          return { content: lines.join("\n") };
        } catch (err) {
          return { content: `获取天气失败: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
    {
      name: "weather_forecast",
      description:
        "获取指定城市未来天气预报（今天 + 未来 3 天，共 4 天）。" +
        "参数 city 可以是城市名（如「深圳」「北京市」）或 6 位行政区划编码 (adcode)。",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名称或 adcode，例如 \"深圳\" 或 \"440300\"" },
        },
        required: ["city"],
      },
      execute: async (params) => {
        try {
          const key = resolveKey(params);
          const city = (params.city as string) || "北京";
          const adcode = await resolveAdcode(city, key);
          const data = await fetchWeather(adcode, key, "all");
          const forecast = data.forecasts?.[0];
          if (!forecast) return { content: "未获取到天气预报数据", isError: true };

          const lines = [`📍 ${forecast.province} ${forecast.city} 天气预报`, ""];

          for (const cast of forecast.casts) {
            const weekday = WEEKDAY_NAMES[Number(cast.week)] ?? "";
            const dayLabel = `${cast.date} ${weekday}`;

            let line = `${dayLabel}：`;
            if (cast.dayweather === cast.nightweather) {
              line += cast.dayweather;
            } else {
              line += `${cast.dayweather}转${cast.nightweather}`;
            }
            line += `，${cast.nighttemp}°~${cast.daytemp}°C`;
            line += `，${cast.daywind}风${cast.daypower}级`;
            lines.push(line);
          }

          lines.push("", `🕐 数据发布: ${forecast.reporttime}`);
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
