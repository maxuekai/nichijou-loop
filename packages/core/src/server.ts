import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statfsSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname, platform, release, arch, cpus, totalmem, freemem, uptime as osUptime, loadavg } from "node:os";
import { formatDate } from "@nichijou/shared";
import type { ButlerService } from "./butler.js";

const PROCESS_START_TIME = Date.now();

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

      if (path === "/api/system-info" && method === "GET") {
        const totalMem = totalmem();
        const freeMem = freemem();
        const cpuInfo = cpus();
        const cpuModel = cpuInfo[0]?.model ?? "未知";
        const cpuCores = cpuInfo.length;
        const load = loadavg();
        const sysUptime = osUptime();
        const procUptime = Math.floor((Date.now() - PROCESS_START_TIME) / 1000);

        let diskTotal = 0;
        let diskFree = 0;
        try {
          const stats = statfsSync(this.butler.storage.dataDir);
          diskTotal = stats.blocks * stats.bsize;
          diskFree = stats.bavail * stats.bsize;
        } catch { /* ignore */ }

        this.json(res, {
          hostname: hostname(),
          platform: platform(),
          osRelease: release(),
          arch: arch(),
          cpuModel,
          cpuCores,
          memTotal: totalMem,
          memUsed: totalMem - freeMem,
          memFree: freeMem,
          diskTotal,
          diskUsed: diskTotal - diskFree,
          diskFree,
          loadAvg: load.map((l) => Math.round(l * 100) / 100),
          sysUptime,
          processUptime: procUptime,
          nodeVersion: process.version,
          pid: process.pid,
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
        if (body && typeof body === "object" && "plugins" in body) {
          await this.butler.reloadPlugins();
        }
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

      if (path === "/api/family" && method === "PUT") {
        const body = await this.readBody(req) as { name?: string; avatar?: string };
        const family = this.butler.familyManager.updateFamily(body);
        this.json(res, { ok: true, family });
        return;
      }

      if (path === "/api/family/plans" && method === "GET") {
        const routines = this.butler.routineEngine.getSharedRoutines();
        const plans = this.butler.routineEngine.getSharedPlans();
        this.json(res, { routines, plans, overrides: plans });
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
        const plans = this.butler.routineEngine.getPlans(memberId);
        const dayPlan = this.butler.routineEngine.resolveDayPlan(memberId, new Date());
        this.json(res, { member, profile, routines, plans, overrides: plans, dayPlan });
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

      if (path.match(/^\/api\/family\/routines\/[^/]+$/) && method === "PUT") {
        const routineId = path.split("/")[4]!;
        const body = await this.readBody(req) as Record<string, unknown>;
        try {
          this.butler.routineEngine.setSharedRoutine({ ...body, id: routineId } as any);
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

      if (path.match(/^\/api\/family\/routines\/[^/]+$/) && method === "DELETE") {
        const routineId = path.split("/")[4]!;
        try {
          this.butler.routineEngine.deleteSharedRoutine(routineId);
          this.json(res, { ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path === "/api/routines/parse" && method === "POST") {
        try {
          const body = await this.readBody(req) as { memberId: string; description: string };
          if (!body.memberId || !body.description) {
            this.json(res, { ok: false, error: "memberId 和 description 为必填" });
            return;
          }
          const { routine, warnings } = await this.butler.parseRoutineDescription(body.memberId, body.description);
          this.json(res, { ok: true, routine, warnings });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path === "/api/plans/parse" && method === "POST") {
        try {
          const body = await this.readBody(req) as { memberId: string; description: string };
          if (!body.memberId || !body.description) {
            this.json(res, { ok: false, error: "memberId 和 description 为必填" });
            return;
          }
          const { plan, warnings } = await this.butler.parsePlanDescription(body.memberId, body.description);
          this.json(res, { ok: true, plan, warnings });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.startsWith("/api/routines/") && method === "GET") {
        const memberId = path.split("/")[3]!;
        const routines = this.butler.routineEngine.getRoutines(memberId);
        const plans = this.butler.routineEngine.getPlans(memberId);
        this.json(res, { routines, plans, overrides: plans });
        return;
      }

      if (path.startsWith("/api/plans/") && (method === "PUT" || method === "DELETE")) {
        const parts = path.split("/");
        const memberId = parts[3]!;
        const planId = parts[4]!;
        if (method === "PUT") {
          const body = await this.readBody(req) as Record<string, unknown>;
          this.butler.routineEngine.updatePlan(memberId, planId, body as never);
          this.json(res, { ok: true });
        } else {
          const removed = this.butler.routineEngine.removePlan(memberId, planId);
          this.json(res, { ok: removed });
        }
        return;
      }

      if (path.startsWith("/api/family/plans/") && (method === "PUT" || method === "DELETE")) {
        const parts = path.split("/");
        const planId = parts[4]!;
        if (method === "PUT") {
          const body = await this.readBody(req) as Record<string, unknown>;
          this.butler.routineEngine.updateSharedPlan(planId, body as never);
          this.json(res, { ok: true });
        } else {
          const removed = this.butler.routineEngine.removeSharedPlan(planId);
          this.json(res, { ok: removed });
        }
        return;
      }

      if (path.startsWith("/api/day-plan/") && method === "GET") {
        const memberId = path.split("/")[3]!;
        const plan = this.butler.routineEngine.resolveDayPlan(memberId, new Date());
        this.json(res, plan);
        return;
      }

      if (path.startsWith("/api/action-logs/") && method === "GET") {
        const memberId = path.split("/")[3]!;
        const reqUrl = new URL(req.url ?? "", `http://${req.headers.host}`);
        const parsedLimit = parseInt(reqUrl.searchParams.get("limit") ?? "20", 10);
        const safeLimit = Number.isFinite(parsedLimit)
          ? Math.min(200, Math.max(1, parsedLimit))
          : 20;
        const logs = this.butler.db.getActionExecutionLogs(memberId, safeLimit);
        this.json(res, logs);
        return;
      }

      if (path.startsWith("/api/overrides/") && (method === "PUT" || method === "DELETE")) {
        const parts = path.split("/");
        const memberId = parts[3]!;
        const overrideId = parts[4]!;
        if (method === "PUT") {
          const body = await this.readBody(req) as Record<string, unknown>;
          this.butler.routineEngine.updateOverride(memberId, overrideId, body as never);
          this.json(res, { ok: true });
        } else {
          const removed = this.butler.routineEngine.removeOverride(memberId, overrideId);
          this.json(res, { ok: removed });
        }
        return;
      }

      if (path.startsWith("/api/family/overrides/") && (method === "PUT" || method === "DELETE")) {
        const parts = path.split("/");
        const overrideId = parts[4]!;
        if (method === "PUT") {
          const body = await this.readBody(req) as Record<string, unknown>;
          this.butler.routineEngine.updateSharedOverride(overrideId, body as never);
          this.json(res, { ok: true });
        } else {
          const removed = this.butler.routineEngine.removeSharedOverride(overrideId);
          this.json(res, { ok: removed });
        }
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

      // --- Plugins API ---
      if (path === "/api/plugins" && method === "GET") {
        const plugins = this.butler.pluginHost.getAllPlugins().map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          version: p.version,
          enabled: this.butler.pluginHost.isEnabled(p.id),
          tools: p.tools.map((t) => ({ name: t.name, description: t.description })),
        }));
        this.json(res, plugins);
        return;
      }

      if (path === "/api/plugins/tools" && method === "GET") {
        this.json(res, this.butler.pluginHost.getAvailableTools());
        return;
      }

      // --- Geo API ---
      if (path === "/api/geo/detect" && method === "GET") {
        try {
          const geoResp = await fetch("https://ipapi.co/json/", {
            signal: AbortSignal.timeout(8000),
            headers: { "User-Agent": "NichijouLoop/1.0" },
          });
          const geo = await geoResp.json() as { latitude?: number; longitude?: number; city?: string; region?: string; country_name?: string };
          const lat = geo.latitude ? String(geo.latitude) : "";
          const lon = geo.longitude ? String(geo.longitude) : "";
          const name = [geo.city, geo.region].filter(Boolean).join(", ") || geo.country_name || "";
          this.json(res, { lat, lon, name });
        } catch {
          this.json(res, { lat: "", lon: "", name: "", error: "无法自动检测位置" });
        }
        return;
      }

      // --- Board endpoints ---
      if (path === "/api/board/weather" && method === "GET") {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const cfgLoc = this.butler.config.get().location;
        const lat = url.searchParams.get("lat") ?? cfgLoc?.lat ?? "39.9";
        const lon = url.searchParams.get("lon") ?? cfgLoc?.lon ?? "116.4";

        if (weatherCache && Date.now() - weatherCache.fetchedAt < WEATHER_CACHE_TTL) {
          this.json(res, weatherCache.data);
          return;
        }

        try {
          const [nowResult, forecastResult] = await Promise.all([
            this.butler.pluginHost.executeTool("weather_now", { lat, lon }),
            this.butler.pluginHost.executeTool("weather_forecast", { lat, lon, days: 1, startDay: 0 }),
          ]);

          const lines = nowResult.content.split("\n");
          const locLine = lines.find((l) => l.startsWith("\u{1F4CD}"));
          const tempLine = lines.find((l) => l.startsWith("\u{1F321}"));
          const rangeLine = lines.find((l) => l.startsWith("\u2195"));

          const location = locLine?.replace("\u{1F4CD} ", "") ?? "";
          const tempMatch = tempLine?.match(/([-\d]+)°C/);
          const temp = tempMatch ? parseInt(tempMatch[1]!) : null;
          const descMatch = tempLine?.match(/· (.+)/);
          const description = descMatch ? descMatch[1]! : "未知";
          const rangeMatch = rangeLine?.match(/([-\d]+)° \/ ([-\d]+)°/);
          const tempMin = rangeMatch ? parseInt(rangeMatch[1]!) : null;
          const tempMax = rangeMatch ? parseInt(rangeMatch[2]!) : null;

          const codeMap: Record<string, number> = {
            "晴": 0, "大部晴朗": 1, "局部多云": 2, "多云": 3,
            "雾": 45, "小雨": 61, "中雨": 63, "大雨": 65,
            "小雪": 71, "中雪": 73, "大雪": 75, "阵雨": 80, "雷暴": 95,
          };
          const weatherCode = codeMap[description] ?? 0;

          const data = { temp, tempMax, tempMin, weatherCode, description, location };
          weatherCache = { data: data as WeatherCache["data"], fetchedAt: Date.now() };
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

        const recentActionLogs = this.butler.db.getRecentActionExecutionLogs(120);
        const memberMap = new Map(members.map((m) => [m.id, m]));
        const routineTitleMaps = new Map<string, Map<string, string>>();
        for (const member of members) {
          const routines = this.butler.routineEngine.getRoutines(member.id);
          routineTitleMaps.set(
            member.id,
            new Map(routines.map((r) => [r.id, r.title])),
          );
        }
        const notifications = recentActionLogs.map((log) => ({
          ...log,
          memberName: memberMap.get(log.memberId)?.name ?? log.memberId,
          routineTitle: routineTitleMaps.get(log.memberId)?.get(log.routineId) ?? log.routineId,
        }));

        this.json(res, { family: familyData, members: memberDetails, soul, notifications });
        return;
      }

      // --- Reminder API ---

      if (path === "/api/reminders" && method === "GET") {
        const remindersUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const memberId = remindersUrl.searchParams.get("memberId") ?? undefined;
        const reminders = this.butler.db.getReminders(memberId);
        this.json(res, reminders);
        return;
      }

      if (path === "/api/reminders" && method === "POST") {
        const body = (await this.readBody(req)) as { memberId: string; message: string; triggerAt: string; channel?: string };
        const reminder = this.butler.reminderScheduler.add({
          memberId: body.memberId,
          message: body.message,
          triggerAt: body.triggerAt,
          channel: (body.channel as "wechat" | "dashboard" | "both") ?? "wechat",
        });
        this.json(res, reminder, 201);
        return;
      }

      if (path.startsWith("/api/reminders/") && method === "PUT") {
        const id = path.split("/")[3]!;
        const body = (await this.readBody(req)) as { message?: string; triggerAt?: string; channel?: string };
        this.butler.db.updateReminder(id, body);
        if (body.triggerAt) {
          this.butler.reminderScheduler.reschedule(id);
        }
        this.json(res, { ok: true });
        return;
      }

      if (path.startsWith("/api/reminders/") && method === "DELETE") {
        const id = path.split("/")[3]!;
        this.butler.reminderScheduler.cancel(id);
        this.json(res, { ok: true });
        return;
      }

      // --- Avatar API ---
      if (path.match(/^\/api\/members\/[^/]+\/avatar$/) && method === "POST") {
        const memberId = path.split("/")[3]!;
        try {
          const { buffer, ext } = await this.readAvatarUpload(req);
          const filename = `${memberId}${ext}`;
          this.butler.storage.writeBinary(`media/avatars/${filename}`, buffer);
          this.butler.familyManager.updateMember(memberId, { avatar: filename });
          this.json(res, { ok: true, avatar: filename });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/avatars\/[^/]+$/) && method === "GET") {
        const filename = decodeURIComponent(path.split("/")[3]!);
        const data = this.butler.storage.readBinary(`media/avatars/${filename}`);
        if (!data) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const ext = extname(filename).toLowerCase();
        const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=3600" });
        res.end(data);
        return;
      }

      if (path === "/api/butler/avatar" && method === "POST") {
        try {
          const { buffer, ext } = await this.readAvatarUpload(req);
          const filename = `butler${ext}`;
          this.butler.storage.writeBinary(`media/avatars/${filename}`, buffer);
          this.json(res, { ok: true, avatar: filename });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path === "/api/family/avatar" && method === "POST") {
        try {
          const { buffer, ext } = await this.readAvatarUpload(req);
          const filename = `family${ext}`;
          this.butler.storage.writeBinary(`media/avatars/${filename}`, buffer);
          const family = this.butler.familyManager.updateFamily({ avatar: filename });
          this.json(res, { ok: true, avatar: filename, family });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path === "/api/family/avatar" && method === "GET") {
        const family = this.butler.familyManager.getFamily();
        this.json(res, { avatar: family?.avatar ?? null });
        return;
      }

      if (path === "/api/butler/avatar" && method === "GET") {
        const avatarDir = this.butler.storage.resolve("media/avatars");
        const files = existsSync(avatarDir)
          ? readdirSync(avatarDir).filter((f) => f.startsWith("butler."))
          : [];
        if (files.length > 0) {
          this.json(res, { avatar: files[0] });
        } else {
          this.json(res, { avatar: null });
        }
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

  private readAvatarUpload(req: IncomingMessage): Promise<{ buffer: Buffer; ext: string }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks);
          const ct = req.headers["content-type"] ?? "";
          if (ct.includes("application/json")) {
            const body = JSON.parse(raw.toString()) as { data: string; filename?: string };
            const match = body.data.match(/^data:image\/(\w+);base64,(.+)$/);
            if (!match) {
              reject(new Error("Invalid base64 data URL"));
              return;
            }
            const imgExt = match[1] === "jpeg" ? ".jpg" : `.${match[1]}`;
            const buffer = Buffer.from(match[2]!, "base64");
            resolve({ buffer, ext: imgExt });
          } else {
            const ext = ct.includes("png") ? ".png" : ct.includes("gif") ? ".gif" : ct.includes("webp") ? ".webp" : ".jpg";
            resolve({ buffer: raw, ext });
          }
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }
}
