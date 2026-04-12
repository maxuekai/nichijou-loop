import { definePlugin } from "@nichijou/plugin-sdk";

interface AmapGeoResp {
  status: string;
  geocodes?: { adcode: string; city: string }[];
}

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

async function fetchWeatherRaw(adcode: string, key: string, extensions: "base" | "all"): Promise<string> {
  const url = `https://restapi.amap.com/v3/weather/weatherInfo?city=${adcode}&key=${key}&extensions=${extensions}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`高德天气 API 请求失败: ${resp.status}`);
  return resp.text();
}

export default definePlugin({
  id: "weather",
  name: "天气助手",
  description: "基于高德地图 API 的天气查询，返回原始接口数据供 AI 自行理解",
  version: "0.3.0",

  configSchema: {
    amapKey: {
      type: "string",
      description: "高德地图 Web 服务 API Key",
      required: true,
    },
  },

  tools: [
    {
      name: "weather_query",
      description:
        "查询天气原始数据。支持传入城市名或 adcode，并可通过 days/date 请求预报数据。" +
        "接口返回内容将原封不动返回给 AI 进行理解。",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名称或 adcode，例如 \"深圳\" 或 \"440300\"" },
          days: { type: "number", description: "未来第几天（0~3），传入后会查询预报接口" },
          date: { type: "string", description: "目标日期（YYYY-MM-DD），传入后会查询预报接口" },
        },
        required: ["city"],
      },
      execute: async (params) => {
        try {
          const key = resolveKey(params);
          const city = typeof params.city === "string" ? params.city.trim() : "";
          if (!city) {
            return { content: "天气查询失败: city 参数必填（城市名或 6 位 adcode）", isError: true };
          }
          const adcode = await resolveAdcode(city, key);
          const shouldUseForecast = params.days !== undefined || params.date !== undefined;
          const raw = await fetchWeatherRaw(adcode, key, shouldUseForecast ? "all" : "base");
          return { content: raw };
        } catch (err) {
          return { content: `天气查询失败: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ],

  dashboardWidgets: [
    { id: "weather-card", name: "天气卡片", component: "WeatherCard", defaultSize: "small" },
  ],
});
