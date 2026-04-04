import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDate } from "@nichijou/shared";
import type { ButlerService } from "./butler.js";

interface WeatherCache {
  data: { temp: number; tempMax: number; tempMin: number; weatherCode: number; description: string; location: string };
  fetchedAt: number;
}

const WEATHER_CACHE_TTL = 30 * 60 * 1000;
let weatherCache: WeatherCache | null = null;

const WMO_DESCRIPTIONS: Record<number, string> = {
  0: "晴", 1: "大部晴朗", 2: "局部多云", 3: "多云",
  45: "雾", 48: "雾凇", 51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "大冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "阵雨", 81: "中阵雨", 82: "大阵雨",
  85: "小阵雪", 86: "大阵雪", 95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹",
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export class NichijouServer {
  private butler: ButlerService;
  private staticDir: string;

  constructor(butler: ButlerService) {
    this.butler = butler;
    const thisDir = fileURLToPath(new URL(".", import.meta.url));
    this.staticDir = join(thisDir, "..", "..", "web", "dist");
  }

  async start(port: number): Promise<void> {
    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error("[Server] Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      });
    });

    server.listen(port, () => {
      console.log(`[Server] http://localhost:${port}`);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      await this.handleAPI(req, res, path);
      return;
    }

    this.serveStatic(res, path);
  }

  private async handleAPI(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    res.setHeader("Content-Type", "application/json");
    const method = req.method ?? "GET";

    try {
      if (path === "/api/status" && method === "GET") {
        const config = this.butler.config.get();
        const channels = this.butler.gateway.getAllChannelStatuses();
        const today = new Date().toISOString().slice(0, 10);
        const tokenUsage = this.butler.db.getTokenUsage(today);
        this.json(res, {
          setupCompleted: config.setupCompleted,
          llm: { baseUrl: config.llm.baseUrl, model: config.llm.model },
          channels,
          tokenUsage,
        });
        return;
      }

      if (path === "/api/config" && method === "GET") {
        const config = this.butler.config.get();
        this.json(res, { ...config, llm: { ...config.llm, apiKey: config.llm.apiKey ? "***" : "" } });
        return;
      }

      if (path === "/api/config" && method === "PUT") {
        const body = await this.readBody(req);
        this.butler.config.update(body as Record<string, unknown>);
        this.butler.refreshProvider();
        this.json(res, { ok: true });
        return;
      }

      if (path === "/api/family" && method === "GET") {
        const family = this.butler.familyManager.getFamily();
        const members = this.butler.familyManager.getMembers();
        this.json(res, { family, members });
        return;
      }

      if (path === "/api/family" && method === "POST") {
        const body = await this.readBody(req) as { name: string };
        const family = this.butler.familyManager.createFamily(body.name);
        this.json(res, family);
        return;
      }

      if (path === "/api/members" && method === "POST") {
        const body = await this.readBody(req) as { name: string; role?: "admin" | "member" };
        const member = this.butler.familyManager.addMember(body.name, body.role);
        this.json(res, member);
        return;
      }

      if (path.startsWith("/api/members/") && method === "GET") {
        const memberId = path.split("/")[3]!;
        const member = this.butler.familyManager.getMember(memberId);
        const profile = this.butler.storage.readMemberProfile(memberId);
        const routines = this.butler.routineEngine.getRoutines(memberId);
        const overrides = this.butler.routineEngine.getOverrides(memberId);
        const dayPlan = this.butler.routineEngine.resolveDayPlan(memberId, new Date());
        this.json(res, { member, profile, routines, overrides, dayPlan });
        return;
      }

      if (path.startsWith("/api/members/") && method === "PUT") {
        const memberId = path.split("/")[3]!;
        const body = await this.readBody(req) as { profile?: string; name?: string };
        try {
          if (body.profile !== undefined) {
            this.butler.storage.writeMemberProfile(memberId, body.profile);
          }
          if (body.name) {
            this.butler.familyManager.updateMember(memberId, { name: body.name });
          }
          this.json(res, { ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/members\/[^/]+\/interview\/start$/) && method === "POST") {
        const memberId = path.split("/")[3]!;
        try {
          const reply = await this.butler.startInterview(memberId);
          this.json(res, { ok: true, reply });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/members\/[^/]+\/interview\/chat$/) && method === "POST") {
        const memberId = path.split("/")[3]!;
        const body = await this.readBody(req) as { message: string };
        try {
          const reply = await this.butler.interviewChat(memberId, body.message);
          this.json(res, { ok: true, reply });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/members\/[^/]+\/interview\/finish$/) && method === "POST") {
        const memberId = path.split("/")[3]!;
        try {
          const result = await this.butler.finishInterview(memberId);
          this.json(res, { ok: true, ...result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/members\/[^/]+\/interview\/cancel$/) && method === "POST") {
        const memberId = path.split("/")[3]!;
        this.butler.cancelInterview(memberId);
        this.json(res, { ok: true });
        return;
      }

      if (path.match(/^\/api\/members\/[^/]+\/generate-routines$/) && method === "POST") {
        const memberId = path.split("/")[3]!;
        try {
          const routines = await this.butler.generateRoutinesFromProfile(memberId);
          this.json(res, { ok: true, routines });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/members\/[^/]+\/apply-routines$/) && method === "POST") {
        const memberId = path.split("/")[3]!;
        const body = await this.readBody(req) as { routines: Array<Record<string, unknown>> };
        try {
          this.butler.applyRoutines(memberId, body.routines as any);
          this.json(res, { ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.startsWith("/api/members/") && method === "DELETE") {
        const memberId = path.split("/")[3]!;
        try {
          this.butler.familyManager.deleteMember(memberId);
          this.json(res, { ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path === "/api/soul" && method === "GET") {
        const soul = this.butler.storage.readSoul();
        this.json(res, { content: soul });
        return;
      }

      if (path === "/api/soul" && method === "PUT") {
        const body = await this.readBody(req) as { content: string };
        this.butler.storage.writeText("SOUL.md", body.content);
        this.json(res, { ok: true });
        return;
      }

      if (path === "/api/chat" && method === "POST") {
        const body = await this.readBody(req) as { memberId: string; message: string };
        const response = await this.butler.chat(body.memberId, body.message);
        this.json(res, { response });
        return;
      }

      if (path === "/api/logs" && method === "GET") {
        const logs = this.butler.db.getAllConversationLogs(200);
        const members = this.butler.familyManager.getMembers();
        const enriched = logs.map((log) => ({
          ...log,
          memberName: members.find((m) => m.id === log.memberId)?.name ?? log.memberId,
        }));
        this.json(res, { logs: enriched });
        return;
      }

      if (path.startsWith("/api/logs/") && method === "GET") {
        const memberId = path.split("/")[3]!;
        const logs = this.butler.db.getConversationLogs(memberId, 100);
        this.json(res, { logs });
        return;
      }

      if (path.match(/^\/api\/routines\/[^/]+\/[^/]+$/) && method === "PUT") {
        const parts = path.split("/");
        const memberId = parts[3]!;
        const body = await this.readBody(req) as Record<string, unknown>;
        try {
          this.butler.routineEngine.setRoutine(memberId, body as any);
          this.json(res, { ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/routines\/[^/]+\/[^/]+$/) && method === "DELETE") {
        const parts = path.split("/");
        const memberId = parts[3]!;
        const routineId = parts[4]!;
        try {
          this.butler.routineEngine.deleteRoutine(memberId, routineId);
          this.json(res, { ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.startsWith("/api/routines/") && method === "GET") {
        const memberId = path.split("/")[3]!;
        const routines = this.butler.routineEngine.getRoutines(memberId);
        const overrides = this.butler.routineEngine.getOverrides(memberId);
        this.json(res, { routines, overrides });
        return;
      }

      if (path.startsWith("/api/day-plan/") && method === "GET") {
        const memberId = path.split("/")[3]!;
        const plan = this.butler.routineEngine.resolveDayPlan(memberId, new Date());
        this.json(res, plan);
        return;
      }

      if (path === "/api/setup/complete" && method === "POST") {
        this.butler.config.update({ setupCompleted: true });
        this.json(res, { ok: true });
        return;
      }

      if (path === "/api/setup/test-llm" && method === "POST") {
        try {
          const body = await this.readBody(req) as { baseUrl: string; apiKey: string; model: string };
          const { createProvider } = await import("@nichijou/ai");
          const provider = createProvider(body);
          const result = await provider.chat({
            messages: [{ role: "user", content: "Hi, respond with just 'OK'" }],
            maxTokens: 10,
          });
          this.json(res, { ok: true, response: result.message.content });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      // --- WeChat endpoints ---
      if (path === "/api/wechat/status" && method === "GET") {
        const ch = this.butler.getWeChatChannel();
        if (!ch) {
          this.json(res, { available: false, connections: [], pairing: { active: false } });
          return;
        }
        const members = this.butler.familyManager.getMembers();
        const connections = ch.getConnections().map((c) => {
          const member = c.memberId ? members.find((m) => m.id === c.memberId) : null;
          return { ...c, memberName: member?.name ?? null };
        });
        this.json(res, {
          available: true,
          status: ch.getStatus(),
          connections,
          pairing: ch.getPairingStatus(),
        });
        return;
      }

      if (path === "/api/wechat/pair" && method === "POST") {
        const ch = this.butler.getWeChatChannel();
        if (!ch) {
          this.json(res, { ok: false, error: "微信通道未初始化" });
          return;
        }
        try {
          const result = await ch.startPairing();
          this.json(res, { ok: true, ...result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path === "/api/wechat/pair/cancel" && method === "POST") {
        this.butler.getWeChatChannel()?.cancelPairing();
        this.json(res, { ok: true });
        return;
      }

      if (path.startsWith("/api/wechat/connections/") && method === "DELETE") {
        const connectionId = path.split("/")[4]!;
        const ch = this.butler.getWeChatChannel();
        if (!ch) {
          this.json(res, { ok: false, error: "微信通道未初始化" });
          return;
        }
        try {
          ch.removeConnection(connectionId);
          this.json(res, { ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path === "/api/wechat/bind" && method === "POST") {
        const ch = this.butler.getWeChatChannel();
        if (!ch) {
          this.json(res, { ok: false, error: "微信通道未初始化" });
          return;
        }
        try {
          const body = await this.readBody(req) as {
            connectionId: string;
            memberId?: string;
            newMemberName?: string;
          };

          let memberId = body.memberId;

          if (!memberId && body.newMemberName) {
            const member = this.butler.familyManager.addMember(body.newMemberName, "member");
            memberId = member.id;
          }

          if (!memberId) {
            this.json(res, { ok: false, error: "请选择成员或输入新成员名字" });
            return;
          }

          ch.bindMember(body.connectionId, memberId);
          this.butler.familyManager.bindChannel(memberId, "wechat", body.connectionId);
          this.json(res, { ok: true, memberId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      // --- Board endpoints ---
      if (path === "/api/board/weather" && method === "GET") {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const lat = url.searchParams.get("lat") ?? "39.9";
        const lon = url.searchParams.get("lon") ?? "116.4";

        if (weatherCache && Date.now() - weatherCache.fetchedAt < WEATHER_CACHE_TTL) {
          this.json(res, weatherCache.data);
          return;
        }

        try {
          const apiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
          const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(8000) });
          const json = await resp.json() as {
            current: { temperature_2m: number; weather_code: number };
            daily: { temperature_2m_max: number[]; temperature_2m_min: number[] };
          };

          let location = "";
          try {
            const geoResp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=zh&zoom=10`, { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "NichijouLoop/1.0" } });
            const geoJson = await geoResp.json() as { address?: { city?: string; town?: string; county?: string; state?: string; suburb?: string; district?: string } };
            const addr = geoJson.address;
            if (addr) {
              location = addr.city || addr.town || addr.county || addr.district || addr.suburb || addr.state || "";
            }
          } catch { /* location is optional */ }

          const data = {
            temp: Math.round(json.current.temperature_2m),
            tempMax: Math.round(json.daily.temperature_2m_max[0]!),
            tempMin: Math.round(json.daily.temperature_2m_min[0]!),
            weatherCode: json.current.weather_code,
            description: WMO_DESCRIPTIONS[json.current.weather_code] ?? "未知",
            location,
          };
          weatherCache = { data, fetchedAt: Date.now() };
          this.json(res, data);
        } catch {
          this.json(res, { temp: null, description: "获取失败", weatherCode: -1, tempMax: null, tempMin: null, location: "" });
        }
        return;
      }

      if (path === "/api/board/week-schedule" && method === "GET") {
        const members = this.butler.familyManager.getMembers();
        const today = new Date();
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay());

        const schedule: Record<string, Record<string, string[]>> = {};
        for (let i = 0; i < 7; i++) {
          const d = new Date(weekStart);
          d.setDate(weekStart.getDate() + i);
          const dateStr = formatDate(d);
          schedule[dateStr] = {};
          for (const member of members) {
            const plan = this.butler.routineEngine.resolveDayPlan(member.id, d);
            if (plan.items.length > 0) {
              schedule[dateStr]![member.name] = plan.items.map((it) => it.title);
            }
          }
        }
        this.json(res, { schedule });
        return;
      }

      if (path === "/api/board/data" && method === "GET") {
        const familyData = this.butler.familyManager.getFamily();
        const members = this.butler.familyManager.getMembers();
        const soul = this.butler.storage.readSoul();

        const memberDetails = members.map((m) => {
          const profile = this.butler.storage.readMemberProfile(m.id);
          const dayPlan = this.butler.routineEngine.resolveDayPlan(m.id, new Date());
          return { ...m, profile, dayPlan };
        });

        this.json(res, { family: familyData, members: memberDetails, soul });
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.json(res, { error: msg }, 500);
    }
  }

  private serveStatic(res: ServerResponse, urlPath: string): void {
    let filePath = urlPath === "/" ? "/index.html" : urlPath;

    let fullPath = join(this.staticDir, filePath);
    if (!existsSync(fullPath)) {
      fullPath = join(this.staticDir, "index.html");
    }

    if (!existsSync(fullPath)) {
      res.writeHead(404);
      res.end("Not found. Dashboard may not be built yet. Run: pnpm -F @nichijou/web build");
      return;
    }

    const ext = extname(fullPath);
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    const content = readFileSync(fullPath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  }

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      req.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }
}
