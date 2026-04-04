import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ButlerService } from "./butler.js";

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
