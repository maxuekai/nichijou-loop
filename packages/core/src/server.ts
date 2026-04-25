import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statfsSync, readdirSync, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, extname, resolve as pathResolve, sep } from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { hostname, platform, release, arch, cpus, totalmem, freemem, uptime as osUptime, loadavg } from "node:os";
import { getZonedDateTimeParts } from "@nichijou/shared";
import type { SystemLogKind } from "@nichijou/shared";
import type { ButlerService } from "./butler.js";

const PROCESS_START_TIME = Date.now();

interface WeatherCache {
  data: { temp: number; tempMax: number; tempMin: number; weatherCode: number; description: string; location: string };
  fetchedAt: number;
}

const WEATHER_CACHE_TTL = 30 * 60 * 1000;
let weatherCache: WeatherCache | null = null;


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

const MEDIA_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

const THUMBNAIL_IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const AVATAR_IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const MAX_AVATAR_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_REQUEST_BYTES = Math.ceil(MAX_AVATAR_IMAGE_BYTES * 4 / 3) + 4096;

const CONFIG_PATCH_KEYS = new Set([
  "llm",
  "models",
  "port",
  "timezone",
  "setupCompleted",
  "butlerName",
  "plugins",
]);

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
        this.butler.systemLogger.logError({
          source: "Server",
          message: "Unhandled request error",
          input: { method: req.method, url: req.url },
          error: err,
        });
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
        const activeModel = this.butler.modelManager.getActiveModel();
        const channels = this.butler.gateway.getAllChannelStatuses();
        const today = new Date().toISOString().slice(0, 10);
        const tokenUsage = this.butler.db.getTokenUsage(today);
        this.json(res, {
          setupCompleted: config.setupCompleted,
          llm: activeModel
            ? {
                id: activeModel.id,
                name: activeModel.name,
                provider: activeModel.provider,
                baseUrl: activeModel.baseUrl,
                model: activeModel.model,
              }
            : { baseUrl: config.llm.baseUrl, model: config.llm.model },
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
        const patch = this.pickConfigPatch(body);
        this.butler.config.update(patch);
        this.butler.refreshProvider();
        if ("plugins" in patch) {
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
        const body = await this.readBody(req) as { name: string; homeCity?: string; homeAdcode?: string };
        const family = this.butler.familyManager.createFamily({
          name: body.name,
          homeCity: body.homeCity,
          homeAdcode: body.homeAdcode,
        });
        this.json(res, family);
        return;
      }

      if (path === "/api/family" && method === "PUT") {
        const body = await this.readBody(req) as { name?: string; avatar?: string; homeCity?: string; homeAdcode?: string };
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
        const tz = this.butler.config.get().timezone || "Asia/Shanghai";
        const dayPlan = this.butler.routineEngine.resolveDayPlan(memberId, new Date(), tz);
        this.json(res, { member, profile, routines, plans, overrides: plans, dayPlan });
        return;
      }

      if (path.startsWith("/api/members/") && method === "PUT") {
        const memberId = path.split("/")[3]!;
        const body = await this.readBody(req) as { profile?: string; name?: string; wechatNotifyEnabled?: boolean };
        try {
          if (body.profile !== undefined) {
            this.butler.storage.writeMemberProfile(memberId, body.profile);
          }
          if (body.name || body.wechatNotifyEnabled !== undefined) {
            const updates: { name?: string; wechatNotifyEnabled?: boolean } = {};
            if (body.name) updates.name = body.name;
            if (body.wechatNotifyEnabled !== undefined) updates.wechatNotifyEnabled = body.wechatNotifyEnabled;
            this.butler.familyManager.updateMember(memberId, updates);
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
        const startedAt = Date.now();
        const traceId = this.butler.systemLogger.createTraceId("api_chat");
        const body = await this.readBody(req) as { memberId: string; message: string };
        this.butler.systemLogger.logRuntime({
          source: "Server.api.chat",
          message: "Dashboard chat API started",
          input: body,
          traceId,
        });
        try {
          const response = await this.butler.chat(body.memberId, body.message, undefined, traceId);
          this.butler.systemLogger.logRuntime({
            source: "Server.api.chat",
            message: "Dashboard chat API completed",
            input: body,
            output: { response },
            durationMs: Date.now() - startedAt,
            traceId,
          });
          this.json(res, { response });
        } catch (error) {
          this.butler.systemLogger.logError({
            source: "Server.api.chat",
            message: "Dashboard chat API failed",
            input: body,
            error,
            durationMs: Date.now() - startedAt,
            traceId,
          });
          throw error;
        }
        return;
      }

      if (path.startsWith("/api/media/") && (method === "GET" || method === "HEAD")) {
        const mediaRoot = pathResolve(this.butler.storage.resolve("media"));
        const tail = path.slice("/api/media/".length);
        const isHead = method === "HEAD";

        if (tail.endsWith("/thumbnail")) {
          const relative = decodeURIComponent(tail.slice(0, -"/thumbnail".length).replace(/\+/g, " "));
          const resolvedPath = pathResolve(mediaRoot, relative);
          if (resolvedPath !== mediaRoot && !resolvedPath.startsWith(mediaRoot + sep)) {
            this.json(res, { error: "Access denied" }, 403);
            return;
          }
          const ext = extname(relative).toLowerCase();
          if (!THUMBNAIL_IMAGE_EXT.has(ext)) {
            this.json(res, { error: "Not an image file" }, 400);
            return;
          }
          const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
          const sizeParam = reqUrl.searchParams.get("size") ?? "medium";
          const sizes: Record<string, number> = { small: 64, medium: 128, large: 256 };
          const dimension = sizes[sizeParam] ?? 128;
          try {
            const stats = await stat(resolvedPath);
            if (!stats.isFile()) {
              this.json(res, { error: "File not found" }, 404);
              return;
            }
            const thumbnail = await sharp(resolvedPath)
              .resize(dimension, dimension, { fit: "cover", position: "center" })
              .jpeg({ quality: 80 })
              .toBuffer();
            res.writeHead(200, {
              "Content-Type": "image/jpeg",
              "Content-Length": String(thumbnail.length),
              "Cache-Control": "public, max-age=86400",
            });
            if (isHead) {
              res.end();
            } else {
              res.end(thumbnail);
            }
          } catch (err) {
            const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
            if (code === "ENOENT") {
              this.json(res, { error: "File not found" }, 404);
              return;
            }
            console.error("[Server] Thumbnail generation error:", err);
            this.json(res, { error: "Thumbnail generation failed" }, 500);
          }
          return;
        }

        const relative = decodeURIComponent(tail.replace(/\+/g, " "));
        const resolvedPath = pathResolve(mediaRoot, relative);
        if (resolvedPath !== mediaRoot && !resolvedPath.startsWith(mediaRoot + sep)) {
          this.json(res, { error: "Access denied" }, 403);
          return;
        }
        try {
          const stats = await stat(resolvedPath);
          if (!stats.isFile()) {
            this.json(res, { error: "File not found" }, 404);
            return;
          }
          const ext = extname(relative).toLowerCase();
          const mimeType = MEDIA_MIME_TYPES[ext] ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": mimeType,
            "Content-Length": String(stats.size),
            "Cache-Control": "public, max-age=3600",
          });
          if (isHead) {
            res.end();
            return;
          }
          const stream = createReadStream(resolvedPath);
          stream.on("error", (streamErr) => {
            console.error("[Server] Media stream error:", streamErr);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Internal server error" }));
            } else {
              res.destroy();
            }
          });
          stream.pipe(res);
        } catch (err) {
          const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
          if (code === "ENOENT") {
            this.json(res, { error: "File not found" }, 404);
            return;
          }
          console.error("[Server] Media access error:", err);
          this.json(res, { error: "Internal server error" }, 500);
        }
        return;
      }

      if (path === "/api/logs" && method === "GET") {
        const logs = this.butler.db.getConversationLogsWithMedia(200);
        const members = this.butler.familyManager.getMembers();
        const enriched = logs.map((log) => ({
          ...log,
          memberName: members.find((m) => m.id === log.memberId)?.name ?? log.memberName,
        }));
        this.json(res, { logs: enriched });
        return;
      }

      if (path === "/api/logs/system" && method === "GET") {
        const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const kindParam = requestUrl.searchParams.get("kind") ?? "runtime";
        if (kindParam !== "runtime" && kindParam !== "error") {
          this.json(res, { error: "kind 必须是 runtime 或 error" }, 400);
          return;
        }
        const rawLimit = Number(requestUrl.searchParams.get("limit") ?? 200);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : 200;
        const logs = this.butler.db.getSystemLogs(kindParam as SystemLogKind, limit);
        this.json(res, { logs });
        return;
      }

      if (path === "/api/logs/cleanup" && method === "POST") {
        try {
          const body = await this.readBody(req) as { daysToKeep?: number; target?: "conversation" | "runtime" | "error" | "all" };
          const daysToKeep = typeof body.daysToKeep === "number" ? body.daysToKeep : 90;
          const target = body.target ?? "conversation";
          
          // 验证参数合理性
          if (daysToKeep < 0 || daysToKeep > 365) {
            this.json(res, { error: "保留天数必须在0-365之间" }, 400);
            return;
          }

          if (!["conversation", "runtime", "error", "all"].includes(target)) {
            this.json(res, { error: "清理目标无效" }, 400);
            return;
          }
          
          const startedAt = Date.now();
          const traceId = this.butler.systemLogger.createTraceId("cleanup_api");
          this.butler.systemLogger.logRuntime({
            source: "Server.api.logs.cleanup",
            message: "Manual log cleanup started",
            input: { target, daysToKeep },
            traceId,
          });

          const counts = {
            conversation: 0,
            runtime: 0,
            error: 0,
          };

          const estimated = {
            conversation: 0,
            runtime: 0,
            error: 0,
          };

          if (target === "conversation" || target === "all") {
            estimated.conversation = this.butler.db.getConversationLogsToDeleteCount(daysToKeep);
            counts.conversation = this.butler.db.cleanOldConversationLogs(daysToKeep);
            counts.conversation += this.butler.db.cleanExcessConversationLogs(10000);
          }

          if (target === "runtime" || target === "all") {
            estimated.runtime = this.butler.db.getSystemLogsToDeleteCount("runtime", daysToKeep);
            counts.runtime = this.butler.db.cleanOldSystemLogs("runtime", daysToKeep);
            counts.runtime += this.butler.db.cleanExcessSystemLogs("runtime", 10000);
          }

          if (target === "error" || target === "all") {
            estimated.error = this.butler.db.getSystemLogsToDeleteCount("error", daysToKeep);
            counts.error = this.butler.db.cleanOldSystemLogs("error", daysToKeep);
            counts.error += this.butler.db.cleanExcessSystemLogs("error", 10000);
          }

          const actualDeletedCount = counts.conversation + counts.runtime + counts.error;
          const toDeleteCount = estimated.conversation + estimated.runtime + estimated.error;

          this.butler.systemLogger.logRuntime({
            source: "Server.api.logs.cleanup",
            message: "Manual log cleanup completed",
            input: { target, daysToKeep },
            output: { deletedCount: actualDeletedCount, estimatedCount: toDeleteCount, counts },
            durationMs: Date.now() - startedAt,
            traceId,
          });
          
          this.json(res, { 
            success: true, 
            deletedCount: actualDeletedCount,
            estimatedCount: toDeleteCount,
            counts,
            daysToKeep 
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.butler.systemLogger.logError({
            source: "Server.api.logs.cleanup",
            message: "Manual log cleanup failed",
            error: err,
          });
          this.json(res, { error: msg }, 500);
        }
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

      if (path.match(/^\/api\/members\/[^/]+\/routines\/[^/]+\/trigger$/) && method === "POST") {
        const parts = path.split("/");
        const memberId = parts[3]!;
        const routineId = parts[5]!;
        try {
          const member = this.butler.familyManager.getMember(memberId);
          if (!member) {
            this.json(res, { ok: false, error: "成员不存在" });
            return;
          }
          const routine = this.butler.routineEngine.getRoutines(memberId).find((r) => r.id === routineId);
          if (!routine) {
            this.json(res, { ok: false, error: "习惯不存在" });
            return;
          }
          const executedActions = await this.butler.actionExecutor.triggerRoutineNow(memberId, routine);
          this.json(res, { ok: true, executedActions });
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

      if (path === "/api/routines/parse" && method !== "POST") {
        this.json(res, { error: "Method Not Allowed" }, 405);
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
        const tz = this.butler.config.get().timezone || "Asia/Shanghai";
        const plan = this.butler.routineEngine.resolveDayPlan(memberId, new Date(), tz);
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
          const provider = this.butler.wrapProviderWithLogging(createProvider({ ...body, timeZone: this.butler.config.get().timezone }));
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
          const conn = ch.getConnections().find((c) => c.connectionId === connectionId);
          ch.removeConnection(connectionId);
          if (conn?.memberId) {
            try {
              this.butler.familyManager.unbindChannel(conn.memberId, "wechat", connectionId);
            } catch { /* ignore stale member metadata */ }
          }
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

          const member = this.butler.familyManager.getMember(memberId);
          if (!member) {
            this.json(res, { ok: false, error: "成员不存在" });
            return;
          }

          const conn = ch.getConnections().find((c) => c.connectionId === body.connectionId);
          if (!conn) {
            this.json(res, { ok: false, error: "连接不存在" });
            return;
          }

          if (conn.memberId && conn.memberId !== memberId) {
            try {
              this.butler.familyManager.unbindChannel(conn.memberId, "wechat", body.connectionId);
            } catch { /* ignore stale member metadata */ }
          }

          const oldConnectionId = member.channelBindings.wechat;
          if (oldConnectionId && oldConnectionId !== body.connectionId) {
            try {
              ch.removeConnection(oldConnectionId);
            } catch { /* ignore missing stale connection */ }
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
          configSchema: p.configSchema ?? null,
        }));
        this.json(res, plugins);
        return;
      }

      if (path === "/api/plugins/tools" && method === "GET") {
        this.json(res, this.butler.pluginHost.getAvailableTools());
        return;
      }

      {
        const pluginConfigMatch = path.match(/^\/api\/plugins\/([^/]+)\/config$/);
        if (pluginConfigMatch) {
          const pluginId = pluginConfigMatch[1]!;
          const plugin = this.butler.pluginHost.getPlugin(pluginId);
          if (!plugin) {
            this.json(res, { error: `plugin not found: ${pluginId}` }, 404);
            return;
          }
          if (method === "GET") {
            this.json(res, {
              config: this.butler.pluginHost.getPluginConfig(pluginId),
              configSchema: plugin.configSchema ?? null,
            });
            return;
          }
          if (method === "PUT") {
            const body = await this.readBody(req);
            this.butler.pluginHost.setPluginConfig(pluginId, body as Record<string, unknown>);
            this.json(res, { ok: true });
            return;
          }
        }
      }

      {
        const pluginToggleMatch = path.match(/^\/api\/plugins\/([^/]+)\/enabled$/);
        if (pluginToggleMatch && method === "PUT") {
          const pluginId = pluginToggleMatch[1]!;
          const plugin = this.butler.pluginHost.getPlugin(pluginId);
          if (!plugin) {
            this.json(res, { error: `plugin not found: ${pluginId}` }, 404);
            return;
          }
          const body = await this.readBody(req) as { enabled: boolean };
          const result = this.butler.pluginHost.setEnabled(pluginId, body.enabled);
          if (!result.ok) {
            this.json(res, { ok: false, error: result.error });
          } else {
            this.json(res, { ok: true });
          }
          return;
        }
      }

      // --- Models API ---
      if (path === "/api/models" && method === "GET") {
        const models = this.butler.modelManager.getAllModels();
        const activeModelId = this.butler.modelManager.getActiveModel()?.id || '';

        // 隐藏敏感信息
        const safeModels = models.map((m) => ({
          ...m,
          apiKey: m.apiKey ? "***" : "",
        }));
        this.json(res, { models: safeModels, activeModelId });
        return;
      }

      if (path === "/api/models" && method === "POST") {
        const body = await this.readBody(req) as Omit<import("./storage/config.js").LLMModelConfig, 'id' | 'createdAt'>;
        try {
          const id = this.butler.modelManager.addModel(body);
          this.json(res, { ok: true, id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/models\/[^/]+$/) && method === "PUT") {
        const modelId = path.split("/")[3]!;
        const body = await this.readBody(req) as Partial<import("./storage/config.js").LLMModelConfig>;
        try {
          this.butler.modelManager.updateModel(modelId, body);
          // 如果更新的是活跃模型，刷新provider
          const activeModel = this.butler.modelManager.getActiveModel();
          if (activeModel?.id === modelId) {
            this.butler.refreshProvider();
          }
          this.json(res, { ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/models\/[^/]+$/) && method === "DELETE") {
        const modelId = path.split("/")[3]!;
        try {
          this.butler.modelManager.deleteModel(modelId);
          this.butler.refreshProvider(); // 删除后刷新provider
          this.json(res, { ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/models\/[^/]+\/test$/) && method === "POST") {
        const modelId = path.split("/")[3]!;
        const model = this.butler.modelManager.getModelById(modelId);
        if (!model) {
          this.json(res, { ok: false, error: "模型不存在" });
          return;
        }

        try {
          const result = await this.butler.modelManager.testModel(model);
          this.json(res, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { success: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/models\/[^/]+\/activate$/) && method === "PUT") {
        const modelId = path.split("/")[3]!;
        try {
          this.butler.modelManager.activateModel(modelId);
          this.butler.refreshProvider(); // 激活后刷新provider
          this.json(res, { ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      // --- Tools API ---
      if (path === "/api/tools" && method === "GET") {
        this.json(res, this.butler.getAllToolDescriptions());
        return;
      }

      {
        const toolExecMatch = path.match(/^\/api\/tools\/([^/]+)\/execute$/);
        if (toolExecMatch && method === "POST") {
          const toolName = decodeURIComponent(toolExecMatch[1]!);
          const body = await this.readBody(req) as Record<string, unknown> | null;
          const params = body ?? {};
          const result = await this.butler.executeTool(toolName, params);
          this.json(res, result);
          return;
        }
      }

      // --- Context management ---
      {
        const clearCtxMatch = path.match(/^\/api\/members\/([^/]+)\/clear-context$/);
        if (clearCtxMatch && method === "POST") {
          const memberId = clearCtxMatch[1]!;
          this.butler.clearMemberSession(memberId);
          this.json(res, { ok: true });
          return;
        }
      }

      if (path === "/api/clear-context" && method === "POST") {
        this.butler.clearAllSessions();
        this.json(res, { ok: true });
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
        const family = this.butler.familyManager.getFamily();
        const city = url.searchParams.get("city") ?? family?.homeAdcode ?? family?.homeCity ?? "";

        if (!city) {
          this.json(res, { temp: null, description: "未配置家庭常居地", weatherCode: -1, tempMax: null, tempMin: null, location: "" });
          return;
        }

        if (weatherCache && Date.now() - weatherCache.fetchedAt < WEATHER_CACHE_TTL) {
          this.json(res, weatherCache.data);
          return;
        }

        try {
          const nowResult = await this.butler.pluginHost.executeTool("weather_query", { city });
          if (nowResult.isError) {
            throw new Error(nowResult.content);
          }
          const raw = JSON.parse(nowResult.content) as {
            lives?: Array<{ province?: string; city?: string; weather?: string; temperature?: string }>;
          };
          const live = raw.lives?.[0];
          const description = live?.weather ?? "未知";
          const temp = live?.temperature ? parseInt(live.temperature, 10) : null;
          const location = [live?.province, live?.city].filter(Boolean).join(" ");

          const codeMap: Record<string, number> = {
            "晴": 0, "大部晴朗": 1, "局部多云": 2, "多云": 3,
            "雾": 45, "小雨": 61, "中雨": 63, "大雨": 65,
            "小雪": 71, "中雪": 73, "大雪": 75, "阵雨": 80, "雷暴": 95,
          };
          const weatherCode = codeMap[description] ?? 0;

          const data = { temp, tempMax: null as number | null, tempMin: null as number | null, weatherCode, description, location };
          weatherCache = { data: data as WeatherCache["data"], fetchedAt: Date.now() };
          this.json(res, data);
        } catch {
          this.json(res, { temp: null, description: "获取失败", weatherCode: -1, tempMax: null, tempMin: null, location: "" });
        }
        return;
      }

      if (path === "/api/board/week-schedule" && method === "GET") {
        const members = this.butler.familyManager.getMembers();
        const tz = this.butler.config.get().timezone || "Asia/Shanghai";
        const now = new Date();
        const zonedNow = getZonedDateTimeParts(now, tz);
        const weekStart = new Date(`${zonedNow.date}T00:00:00`);
        weekStart.setDate(weekStart.getDate() - zonedNow.weekday);

        const schedule: Record<string, Record<string, string[]>> = {};
        for (let i = 0; i < 7; i++) {
          const d = new Date(weekStart);
          d.setDate(weekStart.getDate() + i);
          const dateStr = getZonedDateTimeParts(d, tz).date;
          schedule[dateStr] = {};
          for (const member of members) {
            const plan = this.butler.routineEngine.resolveDayPlan(member.id, d, tz);
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
          const tz = this.butler.config.get().timezone || "Asia/Shanghai";
          const dayPlan = this.butler.routineEngine.resolveDayPlan(m.id, new Date(), tz);
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
          routineTitle: log.routineId.startsWith("reminder_")
            ? "提醒事项"
            : (routineTitleMaps.get(log.memberId)?.get(log.routineId) ?? log.routineId),
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
          const storagePath = this.avatarStoragePath(filename);
          if (!storagePath) throw new Error("Invalid avatar filename");
          this.butler.storage.writeBinary(storagePath, buffer);
          this.butler.familyManager.updateMember(memberId, { avatar: filename });
          this.json(res, { ok: true, avatar: filename });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.json(res, { ok: false, error: msg });
        }
        return;
      }

      if (path.match(/^\/api\/avatars\/[^/]+$/) && method === "GET") {
        const filename = this.normalizeAvatarFilename(path.split("/")[3]!);
        if (!filename) {
          this.json(res, { error: "Invalid avatar filename" }, 400);
          return;
        }
        const storagePath = this.avatarStoragePath(filename);
        if (!storagePath) {
          this.json(res, { error: "Invalid avatar filename" }, 400);
          return;
        }
        const data = this.butler.storage.readBinary(storagePath);
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
          const storagePath = this.avatarStoragePath(filename);
          if (!storagePath) throw new Error("Invalid avatar filename");
          this.butler.storage.writeBinary(storagePath, buffer);
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
          const storagePath = this.avatarStoragePath(filename);
          if (!storagePath) throw new Error("Invalid avatar filename");
          this.butler.storage.writeBinary(storagePath, buffer);
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
      this.butler.systemLogger.logError({
        source: "Server.api",
        message: "API request failed",
        input: { method, path },
        error: err,
      });
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
      const maxBodySize = 1024 * 1024;
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > maxBodySize) {
          reject(new Error("Request body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (!data.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  private pickConfigPatch(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== "object") return {};
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (CONFIG_PATCH_KEYS.has(key)) {
        patch[key] = value;
      }
    }
    return patch;
  }

  private normalizeAvatarExtension(ext: string): string | null {
    const normalized = ext.toLowerCase() === ".jpeg" ? ".jpg" : ext.toLowerCase();
    return AVATAR_IMAGE_EXT.has(normalized) ? normalized : null;
  }

  private avatarExtensionFromContentType(contentType: string): string | null {
    const mime = contentType.toLowerCase().split(";")[0]?.trim();
    if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
    if (mime === "image/png") return ".png";
    if (mime === "image/gif") return ".gif";
    if (mime === "image/webp") return ".webp";
    return null;
  }

  private normalizeAvatarFilename(raw: string): string | null {
    let filename: string;
    try {
      filename = decodeURIComponent(raw).trim();
    } catch {
      return null;
    }

    if (
      !filename
      || filename.length > 128
      || filename.includes("..")
      || /[/\\\0%]/.test(filename)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)
    ) {
      return null;
    }

    const originalExt = extname(filename);
    const ext = this.normalizeAvatarExtension(originalExt);
    if (!ext) return null;
    return filename;
  }

  private avatarStoragePath(raw: string): string | null {
    const filename = this.normalizeAvatarFilename(raw);
    if (!filename) return null;

    const avatarRoot = pathResolve(this.butler.storage.resolve("media/avatars"));
    const fullPath = pathResolve(avatarRoot, filename);
    if (fullPath === avatarRoot || !fullPath.startsWith(avatarRoot + sep)) {
      return null;
    }
    return `media/avatars/${filename}`;
  }

  private assertAvatarSize(buffer: Buffer): void {
    if (buffer.length > MAX_AVATAR_IMAGE_BYTES) {
      throw new Error(`Avatar image exceeds ${(MAX_AVATAR_IMAGE_BYTES / 1024 / 1024).toFixed(0)}MB`);
    }
  }

  private readAvatarUpload(req: IncomingMessage): Promise<{ buffer: Buffer; ext: string }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
        req.destroy();
      };

      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_AVATAR_REQUEST_BYTES) {
          fail(new Error(`Avatar upload request exceeds ${(MAX_AVATAR_IMAGE_BYTES / 1024 / 1024).toFixed(0)}MB image limit`));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        try {
          const raw = Buffer.concat(chunks);
          const ct = String(req.headers["content-type"] ?? "");
          if (ct.includes("application/json")) {
            const body = JSON.parse(raw.toString()) as { data: string; filename?: string };
            const match = body.data.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
            if (!match) {
              reject(new Error("Invalid base64 data URL"));
              return;
            }
            const imgExt = this.normalizeAvatarExtension(match[1] === "jpeg" ? ".jpg" : `.${match[1]}`);
            if (!imgExt) {
              reject(new Error("Unsupported avatar image type"));
              return;
            }
            const buffer = Buffer.from(match[2]!, "base64");
            this.assertAvatarSize(buffer);
            resolve({ buffer, ext: imgExt });
          } else {
            const ext = this.avatarExtensionFromContentType(ct);
            if (!ext) {
              reject(new Error("Unsupported avatar image type"));
              return;
            }
            this.assertAvatarSize(raw);
            resolve({ buffer: raw, ext });
          }
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }
}
