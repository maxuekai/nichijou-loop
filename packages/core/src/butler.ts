import { createProvider } from "@nichijou/ai";
import type { LLMProvider } from "@nichijou/ai";
import { AgentSession, createAgentSession } from "@nichijou/agent";
import type { AgentEvent } from "@nichijou/agent";
import type { FamilyMember, InboundMessage, ToolDefinition, Routine } from "@nichijou/shared";
import { hostname, platform, arch, cpus, totalmem, freemem, uptime as osUptime, loadavg } from "node:os";
import type { Channel } from "./gateway/channel.js";
import type { ChannelStatus } from "@nichijou/shared";
import { StorageManager } from "./storage/storage.js";
import { ConfigManager } from "./storage/config.js";
import { Database } from "./db/database.js";
import { FamilyManager } from "./family/family-manager.js";
import { RoutineEngine } from "./routine/routine-engine.js";
import { Gateway } from "./gateway/gateway.js";
import { createFamilyTools } from "./tools/family-tools.js";
import { createRoutineTools } from "./tools/routine-tools.js";
import { createMemoryTools } from "./tools/memory-tools.js";
import { createReminderTools } from "./tools/reminder-tools.js";
import { ReminderScheduler } from "./reminder/reminder-scheduler.js";
import { PluginHost } from "./plugin-host/plugin-host.js";
import { resolvePluginImportUrl } from "./plugins/resolve-plugin.js";
import { ActionExecutor } from "./routine/action-executor.js";

interface WeChatConnection {
  connectionId: string;
  memberId: string | null;
  wechatUserId: string;
  status: string;
  connectedAt?: string;
  lastError?: string;
}

interface WeChatChannelLike extends Channel {
  startPairing(): Promise<{ qrUrl: string; connectionId: string }>;
  getPairingStatus(): { active: boolean; connectionId?: string; qrUrl?: string };
  cancelPairing(): void;
  bindMember(connectionId: string, memberId: string): void;
  removeConnection(connectionId: string): void;
  isMemberBound(memberId: string): boolean;
  getConnections(): WeChatConnection[];
  getStatus(): ChannelStatus;
}

export class ButlerService {
  readonly storage: StorageManager;
  readonly config: ConfigManager;
  readonly db: Database;
  readonly familyManager: FamilyManager;
  readonly routineEngine: RoutineEngine;
  readonly gateway: Gateway;

  readonly reminderScheduler: ReminderScheduler;
  readonly pluginHost: PluginHost;
  readonly actionExecutor: ActionExecutor;

  private provider: LLMProvider | null = null;
  private sessions = new Map<string, AgentSession>();
  private _wechatChannel: WeChatChannelLike | null = null;
  private interviewSessions = new Map<string, Array<{ role: "user" | "assistant" | "system"; content: string }>>();

  constructor(dataDir?: string) {
    this.storage = new StorageManager(dataDir);
    this.config = new ConfigManager(this.storage);
    this.db = new Database(this.storage);
    this.familyManager = new FamilyManager(this.storage);
    this.routineEngine = new RoutineEngine(this.storage);
    this.gateway = new Gateway(this.familyManager);
    this.reminderScheduler = new ReminderScheduler(this.db, this.gateway);
    this.pluginHost = new PluginHost(this.storage);
    this.actionExecutor = new ActionExecutor(
      this.routineEngine, this.familyManager, this.pluginHost,
      this.gateway, null, this.db, this.config,
    );
    this.actionExecutor.setChatFunction((memberId, prompt) => this.chat(memberId, prompt));

    this.gateway.onMessage(this.handleMessage.bind(this));
    this.gateway.onUnboundMessage(this.handleUnboundMessage.bind(this));
  }

  /** 仅加载 `~/.nichijou/config.yaml` 中 `plugins` 列出的包（安装目录 ~/.nichijou/plugins） */
  async registerPlugins(): Promise<void> {
    const pluginsDir = this.storage.resolve("plugins");
    const specs = this.config.get().plugins ?? [];
    if (specs.length === 0) {
      console.log(
        "[Plugin] 未配置插件。在 ~/.nichijou/config.yaml 设置 plugins: [\"@nichijou/plugin-weather\"] 或执行 nichijou plugin install <包名>",
      );
      return;
    }
    for (const spec of specs) {
      try {
        const url = resolvePluginImportUrl(spec, pluginsDir);
        const mod = await import(url) as { default: { id: string; name: string; description: string; version: string; tools: ToolDefinition[] } };
        this.pluginHost.register(mod.default);
      } catch (err) {
        console.warn(`[Plugin] 加载失败 ${spec}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** 配置变更后重新加载插件（如管理后台保存 config） */
  async reloadPlugins(): Promise<void> {
    this.pluginHost.clear();
    await this.registerPlugins();
  }

  async initWeChatChannel(): Promise<void> {
    try {
      const modName = "@nichijou/channel-wechat";
      const mod = await import(/* webpackIgnore: true */ modName) as {
        WeChatChannel: new (storage: StorageManager) => WeChatChannelLike;
      };
      const channel = new mod.WeChatChannel(this.storage) as WeChatChannelLike;
      this.gateway.registerChannel(channel);
      await channel.start(this.gateway);
      this._wechatChannel = channel;
      console.log("[WeChat] 通道已初始化");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[WeChat] 通道初始化失败: ${msg}`);
    }
  }

  getWeChatChannel(): WeChatChannelLike | null {
    return this._wechatChannel;
  }

  getProvider(): LLMProvider {
    if (!this.provider) {
      const cfg = this.config.get();
      this.provider = createProvider(cfg.llm);
      this.actionExecutor.setProvider(this.provider);
    }
    return this.provider;
  }

  refreshProvider(): void {
    this.provider = null;
    this.sessions.clear();
  }

  private buildTools(): ToolDefinition[] {
    return [
      ...createFamilyTools(this.familyManager, this.storage),
      ...createRoutineTools(this.routineEngine, this.familyManager),
      ...createMemoryTools(this.storage),
      ...createReminderTools(this.reminderScheduler),
      ...this.pluginHost.getAllTools(),
    ];
  }

  /** 使用配置时区格式化当前时间，返回人类可读 + ISO 字符串 */
  private formatNow(): { display: string; iso: string } {
    const tz = this.config.get().timezone || "Asia/Shanghai";
    const now = new Date();
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      weekday: "long",
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const display = `${get("year")}年${get("month")}月${get("day")}日 ${get("weekday")} ${get("hour")}:${get("minute")}:${get("second")}`;
    const iso = now.toLocaleString("sv-SE", { timeZone: tz }).replace(" ", "T");
    const offset = this.tzOffset(now, tz);
    return { display, iso: `${iso}${offset} (${tz})` };
  }

  private tzOffset(date: Date, tz: string): string {
    const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
    const local = new Date(date.toLocaleString("en-US", { timeZone: tz }));
    const diff = (local.getTime() - utc.getTime()) / 60000;
    const sign = diff >= 0 ? "+" : "-";
    const h = String(Math.floor(Math.abs(diff) / 60)).padStart(2, "0");
    const m = String(Math.abs(diff) % 60).padStart(2, "0");
    return `${sign}${h}:${m}`;
  }

  private buildSystemPrompt(member?: FamilyMember, isOnboarding = false): string {
    const soul = this.storage.readSoul();
    let prompt = soul + "\n\n---\n\n";

    const { display, iso } = this.formatNow();
    prompt += `# 当前时间\n\n`;
    prompt += `现在是 ${display}\n`;
    prompt += `ISO: ${iso}\n`;
    prompt += `请根据此精确时间推算用户描述中涉及的具体日期时间。当用户说「明天」「后天」「下周一」等相对时间时，必须以此时间为基准计算。\n\n---\n\n`;

    if (member) {
      const profile = this.storage.readMemberProfile(member.id);
      if (profile) {
        prompt += `# 当前对话成员\n\n${profile}\n\n---\n\n`;
      }
      const today = new Date();
      const plan = this.routineEngine.resolveDayPlan(member.id, today);
      if (plan.items.length > 0) {
        prompt += `# 今日计划\n\n`;
        for (const item of plan.items) {
          prompt += `- ${item.timeSlot ?? ""} ${item.title}\n`;
        }
        prompt += "\n---\n\n";
      }
    }

    prompt += `# 功能说明\n\n你有以下工具可以使用来帮助家庭成员管理生活。请根据对话自然地调用工具。\n`;
    prompt += `\n当前成员 ID：${member?.id ?? "未知"}\n`;

    prompt += `\n# 回复规则\n\n`;
    prompt += `- 回复时只输出最终结论和对用户有用的信息\n`;
    prompt += `- 不要输出思考过程、工具调用的中间步骤\n`;
    prompt += `- 保持简洁、自然、温暖的语气\n`;

    if (isOnboarding) {
      prompt += `\n# 新成员引导\n\n`;
      prompt += `这是一位刚刚加入家庭的新成员。请：\n`;
      prompt += `1. 热情欢迎，简要介绍你作为家庭管家能做什么（7 days 习惯管理、健身提醒、行程规划、买菜推荐、做饭菜单、定时提醒等）\n`;
      prompt += `2. 引导他/她告诉你日常生活习惯（比如几点起床、是否健身、周末安排等）\n`;
      prompt += `3. 鼓励他/她随时可以补充和调整\n`;
      prompt += `4. 语气亲切自然，像一个贴心的家人\n`;
    }

    return prompt;
  }

  getOrCreateSession(memberId: string, isOnboarding = false): AgentSession {
    if (!isOnboarding) {
      const existing = this.sessions.get(memberId);
      if (existing) return existing;
    }

    const member = this.familyManager.getMember(memberId);
    const systemPrompt = this.buildSystemPrompt(member ?? undefined, isOnboarding);

    const session = createAgentSession({
      provider: this.getProvider(),
      systemPrompt,
      tools: this.buildTools(),
    });

    this.sessions.set(memberId, session);
    return session;
  }

  /**
   * Chat with logging. Returns the FULL response (for dashboard use).
   * For WeChat, use handleMessage which extracts only the final reply.
   */
  async chat(memberId: string, input: string, onEvent?: (event: AgentEvent) => void): Promise<string> {
    const session = this.getOrCreateSession(memberId);
    const member = this.familyManager.getMember(memberId);
    session.updateSystemPrompt(this.buildSystemPrompt(member ?? undefined));
    const model = this.config.get().llm.model;

    const unsub = session.subscribe((event) => {
      if (event.type === "turn_end" && event.usage) {
        this.db.logTokenUsage(memberId, event.usage.promptTokens, event.usage.completionTokens, model);
      }
    });

    if (onEvent) {
      session.subscribe(onEvent);
    }

    try {
      const response = await session.prompt(input);
      this.db.saveChat(memberId, "user", input);
      this.db.saveChat(memberId, "assistant", response);
      return response;
    } finally {
      unsub();
    }
  }

  private static readonly FINISH_KEYWORDS = ["好了", "完成", "没有了", "差不多了", "就这些", "结束", "可以了", "完成了", "no more", "done"];

  /**
   * Handle an inbound WeChat/channel message.
   * If the member has an active interview, route to the interview flow.
   * Otherwise, normal agent session.
   */
  private async handleMessage(member: FamilyMember, msg: InboundMessage): Promise<void> {
    // Slash commands (admin only)
    if (msg.text.startsWith("/")) {
      const reply = await this.handleSlashCommand(member, msg.text);
      await this.gateway.sendToMember(member.id, reply);
      return;
    }

    // Route to interview if active
    if (this.hasActiveInterview(member.id)) {
      await this.handleInterviewMessage(member, msg.text);
      return;
    }

    const session = this.getOrCreateSession(member.id);
    const events: Array<{ type: string; data: unknown }> = [];
    let lastTurnText = "";
    const model = this.config.get().llm.model;

    const unsubscribe = session.subscribe((event) => {
      events.push({ type: event.type, data: event });
      if (event.type === "turn_end") {
        if (event.message.content) lastTurnText = event.message.content;
        if (event.usage) {
          this.db.logTokenUsage(member.id, event.usage.promptTokens, event.usage.completionTokens, model);
        }
      }
    });

    try {
      await session.prompt(msg.text);
    } finally {
      unsubscribe();
    }

    const reply = lastTurnText || "（无回复）";

    this.db.saveConversationLog(member.id, msg.text, reply, JSON.stringify(events));
    this.db.saveChat(member.id, "user", msg.text);
    this.db.saveChat(member.id, "assistant", reply);

    await this.gateway.sendToMember(member.id, reply);
  }

  /**
   * Handle a message during an active interview session (via WeChat).
   * Detects finish keywords and auto-completes the interview.
   */
  private async handleInterviewMessage(member: FamilyMember, text: string): Promise<void> {
    const trimmed = text.trim();
    const isFinish = ButlerService.FINISH_KEYWORDS.some(
      (kw) => trimmed === kw || trimmed.toLowerCase() === kw,
    );

    if (isFinish) {
      await this.gateway.sendToMember(member.id, "好的，让我来整理一下你的生活习惯，稍等片刻…");
      try {
        const result = await this.finishInterview(member.id);
        let summary = "✅ 已为你整理好个人档案！\n\n";
        if (result.profile) {
          const lines = result.profile.split("\n").slice(0, 8);
          summary += `📋 档案摘要：\n${lines.join("\n")}\n`;
          if (result.profile.split("\n").length > 8) summary += "...\n";
        }
        if (result.routines.length > 0) {
          summary += `\n🔄 为你创建了 ${result.routines.length} 个 7 days 习惯：\n`;
          for (const r of result.routines) {
            const days = r.weekdays.map((d) => ["日", "一", "二", "三", "四", "五", "六"][d]).join("、");
            summary += `  · ${r.title}（每周${days}）\n`;
          }
        }
        summary += "\n你可以随时告诉我调整计划，或在管理页面查看和编辑。";

        // Auto-apply profile and routines
        if (result.profile) {
          this.storage.writeMemberProfile(member.id, result.profile);
        }
        if (result.routines.length > 0) {
          this.applyRoutines(member.id, result.routines);
        }

        await this.gateway.sendToMember(member.id, summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.gateway.sendToMember(member.id, `整理档案时出了点问题：${msg}\n你可以继续对话，或者输入「完成」重试。`);
      }
      return;
    }

    try {
      const reply = await this.interviewChat(member.id, trimmed);
      await this.gateway.sendToMember(member.id, reply);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.gateway.sendToMember(member.id, `出了点问题：${errMsg}`);
    }
  }

  /**
   * Handle a message from an unbound WeChat connection.
   * Guides the user through creating or selecting a member to bind.
   */
  private async handleUnboundMessage(
    _channelId: string,
    connectionId: string,
    text: string,
    send: (reply: string) => Promise<void>,
  ): Promise<void> {
    const trimmed = text.trim();
    const members = this.familyManager.getMembers();

    const membersList = members.length > 0
      ? members.map((m) => `  - ${m.name}`).join("\n")
      : "  （暂无成员）";

    // Try to match existing member by name
    const existingMember = members.find(
      (m) => m.name === trimmed || m.name.toLowerCase() === trimmed.toLowerCase(),
    );

    if (existingMember) {
      // Check duplicate binding
      const ch = this._wechatChannel;
      if (ch?.isMemberBound(existingMember.id)) {
        await send(
          `「${existingMember.name}」已经绑定了微信，不能重复绑定。\n\n` +
          `请输入一个新的名字来创建账号，或选择其他未绑定的成员。\n\n当前家庭成员：\n${membersList}`,
        );
        return;
      }

      // Bind to existing member
      if (ch) {
        ch.bindMember(connectionId, existingMember.id);
        this.familyManager.bindChannel(existingMember.id, "wechat", connectionId);
      }

      await send(`已绑定到「${existingMember.name}」！现在你可以直接和管家对话了。`);

      setTimeout(async () => {
        try {
          const model = this.config.get().llm.model;
          const session = this.getOrCreateSession(existingMember.id);
          const events: Array<{ type: string; data: unknown }> = [];
          let lastText = "";
          const unsub = session.subscribe((e) => {
            events.push({ type: e.type, data: e });
            if (e.type === "turn_end") {
              if (e.message.content) lastText = e.message.content;
              if (e.usage) this.db.logTokenUsage(existingMember.id, e.usage.promptTokens, e.usage.completionTokens, model);
            }
          });
          try {
            await session.prompt("你好，我刚通过微信连接上了，简单提醒我今天有什么安排吧。");
          } finally {
            unsub();
          }
          if (lastText) {
            await this.gateway.sendToMember(existingMember.id, lastText);
          }
        } catch { /* ignore */ }
      }, 1000);
      return;
    }

    // No match: create new member
    if (trimmed.length < 1 || trimmed.length > 20) {
      await send(
        `你好！欢迎使用家庭管家 ✨\n\n` +
        `请输入你的名字来创建账号（1-20个字符），或输入已有成员的名字进行绑定。\n\n` +
        `当前家庭成员：\n${membersList}`,
      );
      return;
    }

    // Create new member
    const newMember = this.familyManager.addMember(trimmed);
    const ch = this._wechatChannel;
    if (ch) {
      ch.bindMember(connectionId, newMember.id);
      this.familyManager.bindChannel(newMember.id, "wechat", connectionId);
    }

    await send(`已为你创建账号「${trimmed}」并绑定成功！`);

    // Auto-start interview to collect lifestyle habits
    setTimeout(async () => {
      try {
        const firstReply = await this.startInterview(newMember.id);
        const intro = [
          `欢迎加入！我是你的家庭管家，接下来让我了解一下你的日常生活习惯，以便为你制定合适的计划 🏠\n`,
          firstReply,
          `\n（回答完所有问题后，输入「完成」即可自动生成你的个人档案和 7 days 习惯）`,
        ].join("\n");
        await this.gateway.sendToMember(newMember.id, intro);
        this.db.saveConversationLog(newMember.id, "[新成员引导]", intro, "[]");
      } catch (err) {
        console.error("[Onboarding] 引导对话启动失败:", err);
        try {
          await this.gateway.sendToMember(
            newMember.id,
            "欢迎加入！你可以直接和我聊天，告诉我你的日常生活习惯，我来帮你安排计划。",
          );
        } catch { /* ignore */ }
      }
    }, 1500);
  }

  /**
   * Handle slash commands. Returns the response text.
   */
  private async handleSlashCommand(member: FamilyMember, text: string): Promise<string> {
    if (member.role !== "admin") {
      return "只有管理员可以使用 / 命令。";
    }

    const [cmd, ...args] = text.slice(1).split(/\s+/);

    switch (cmd) {
      case "help":
        return [
          "可用命令：",
          "  /help     - 显示此帮助",
          "  /status   - 系统状态",
          "  /members  - 成员列表",
          "  /plan     - 今日计划",
          "  /plan @名字 - 查看指定成员的计划",
          "  /usage    - Token 用量",
          "  /wechat   - 微信连接状态",
        ].join("\n");

      case "status": {
        const cfg = this.config.get();
        const wechatStatus = this._wechatChannel?.getStatus();
        const usage = this.db.getTokenUsage(new Date().toISOString().slice(0, 10));

        const totalMem = totalmem();
        const usedMem = totalMem - freemem();
        const memPct = Math.round((usedMem / totalMem) * 100);
        const cpuInfo = cpus();
        const load = loadavg();
        const sysUp = osUptime();
        const procUp = Math.floor(process.uptime());

        const formatBytes = (b: number) => {
          if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)}GB`;
          return `${(b / 1048576).toFixed(0)}MB`;
        };
        const formatUptime = (s: number) => {
          const d = Math.floor(s / 86400);
          const h = Math.floor((s % 86400) / 3600);
          const m = Math.floor((s % 3600) / 60);
          return d > 0 ? `${d}天${h}小时` : h > 0 ? `${h}小时${m}分钟` : `${m}分钟`;
        };

        return [
          "📊 系统状态",
          "",
          `🖥 设备: ${hostname()} (${platform()}/${arch()})`,
          `💻 CPU: ${cpuInfo[0]?.model ?? "未知"} (${cpuInfo.length}核)`,
          `📈 负载: ${load.map((l) => l.toFixed(2)).join(" / ")}`,
          `🧠 内存: ${formatBytes(usedMem)}/${formatBytes(totalMem)} (${memPct}%)`,
          `⏱ 系统运行: ${formatUptime(sysUp)}`,
          `🤖 管家运行: ${formatUptime(procUp)} (PID: ${process.pid})`,
          `🔧 Node.js: ${process.version}`,
          "",
          `🧩 LLM: ${cfg.llm.model} @ ${cfg.llm.baseUrl}`,
          `📱 微信: ${wechatStatus?.connected ? "已连接" : "未连接"} (${wechatStatus?.connectedMembers ?? 0}人在线)`,
          `📊 今日 Token: prompt=${usage.promptTokens} completion=${usage.completionTokens}`,
        ].join("\n");
      }

      case "members": {
        const members = this.familyManager.getMembers();
        if (members.length === 0) return "暂无成员";
        return "👥 家庭成员：\n" + members.map((m) => {
          const bound = this._wechatChannel?.isMemberBound(m.id) ? " 📱" : "";
          return `  ${m.name} (${m.role})${bound}`;
        }).join("\n");
      }

      case "plan": {
        const targetName = args.join(" ").replace("@", "").trim();
        let targetMember = member;
        if (targetName) {
          const found = this.familyManager.getMembers().find((m) => m.name === targetName);
          if (!found) return `未找到成员「${targetName}」`;
          targetMember = found;
        }
        const plan = this.routineEngine.resolveDayPlan(targetMember.id, new Date());
        if (plan.items.length === 0) return `${targetMember.name} 今日无计划`;
        return `📅 ${targetMember.name} 今日计划：\n` + plan.items.map((it) =>
          `  ${it.timeSlot ?? ""} ${it.title}`,
        ).join("\n");
      }

      case "usage": {
        const today = new Date().toISOString().slice(0, 10);
        const usage = this.db.getTokenUsage(today);
        return `📈 今日 Token 用量：\n  Prompt: ${usage.promptTokens}\n  Completion: ${usage.completionTokens}`;
      }

      case "wechat": {
        const ch = this._wechatChannel;
        if (!ch) return "微信通道未初始化";
        const conns = ch.getConnections();
        if (conns.length === 0) return "暂无微信连接";
        const members = this.familyManager.getMembers();
        return "📱 微信连接：\n" + conns.map((c) => {
          const m = c.memberId ? members.find((mem) => mem.id === c.memberId) : null;
          const name = m ? m.name : "未绑定";
          const dot = c.status === "connected" ? "🟢" : c.status === "expired" ? "🔴" : "⚪";
          return `  ${dot} ${name} - ${c.status}`;
        }).join("\n");
      }

      default:
        return `未知命令: /${cmd}\n输入 /help 查看可用命令。`;
    }
  }

  private logProviderUsage(memberId: string, usage: { promptTokens: number; completionTokens: number }): void {
    if (usage.promptTokens > 0 || usage.completionTokens > 0) {
      const model = this.config.get().llm.model;
      this.db.logTokenUsage(memberId, usage.promptTokens, usage.completionTokens, model);
    }
  }

  private buildInterviewSystemPrompt(memberId: string): string {
    const member = this.familyManager.getMember(memberId);
    const existingProfile = this.storage.readMemberProfile(memberId);
    const existing = this.routineEngine.getRoutines(memberId);

    let prompt = [
      "你是一个贴心的家庭管家，正在通过对话了解一位家庭成员的日常生活习惯。",
      "",
      "# 对话规则",
      "- 每次只问一个问题，不要一次性列出多个问题",
      "- 语气亲切自然，像朋友聊天一样",
      "- 根据用户的回答进行追问和展开，而不是机械地按列表提问",
      "- 如果用户的回答比较简短，可以追问具体细节（时间、频率等）",
      "- 如果用户说「没有」或「不需要」，尊重并继续下一个话题",
      "",
      "# 需要了解的方面（自然地覆盖，不必按顺序）",
      "- 作息时间（起床、睡觉的大致时间）",
      "- 工作/学习安排（工作日节奏、通勤等）",
      "- 运动健身习惯（种类、频率、时间）",
      "- 饮食偏好和做饭习惯",
      "- 周末安排和兴趣爱好",
      "- 需要定期提醒的事情",
      "- 其他希望管家帮忙的事情",
      "",
      "# 注意",
      "- 不要自作主张帮用户做决定",
      "- 用户说的每个习惯都很重要，认真记录",
      "- 在对话过程中可以简短确认你听到的信息",
    ].join("\n");

    const { display, iso } = this.formatNow();
    prompt += `\n\n# 当前时间\n现在是 ${display}\nISO: ${iso}`;

    if (member) {
      prompt += `\n\n当前成员：${member.name}`;
    }
    if (existingProfile) {
      prompt += `\n\n已有档案（可以参考，询问是否有变化）：\n${existingProfile}`;
    }
    if (existing.length > 0) {
      prompt += `\n\n已有的 7 days 习惯：\n${existing.map((r) => `- ${r.title}`).join("\n")}`;
    }
    return prompt;
  }

  async startInterview(memberId: string): Promise<string> {
    const systemPrompt = this.buildInterviewSystemPrompt(memberId);
    const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "你好，我想完善一下我的个人档案和生活习惯。" },
    ];

    const provider = this.getProvider();
    const result = await provider.chat({ messages, maxTokens: 500 });
    const reply = result.message.content;

    this.logProviderUsage(memberId, result.usage);
    messages.push({ role: "assistant", content: reply });
    this.interviewSessions.set(memberId, messages);

    return reply;
  }

  async interviewChat(memberId: string, userMessage: string): Promise<string> {
    const messages = this.interviewSessions.get(memberId);
    if (!messages) throw new Error("没有进行中的引导对话，请先开始引导");

    messages.push({ role: "user", content: userMessage });

    const provider = this.getProvider();
    const result = await provider.chat({ messages, maxTokens: 500 });
    const reply = result.message.content;

    this.logProviderUsage(memberId, result.usage);
    messages.push({ role: "assistant", content: reply });
    return reply;
  }

  async finishInterview(memberId: string): Promise<{ profile: string; routines: Routine[] }> {
    const messages = this.interviewSessions.get(memberId);
    if (!messages) throw new Error("没有进行中的引导对话");

    const existing = this.routineEngine.getRoutines(memberId);
    const existingDesc = existing.length > 0
      ? `\n已有的 7 days 习惯（避免重复）：\n${existing.map((r) => `- ${r.title}`).join("\n")}`
      : "";

    const summaryPrompt = [
      "根据以上对话内容，请生成两部分内容：",
      "",
      "## 第一部分：成员档案",
      "用自然语言总结这位成员的个人信息和生活习惯，用 Markdown 格式书写，包含但不限于：",
      "- 基本作息",
      "- 工作/学习情况",
      "- 运动健身",
      "- 饮食习惯",
      "- 周末安排",
      "- 其他特点",
      "",
      "## 第二部分：7 days 习惯 JSON",
      "从对话中提取可以设置为 7 days（以一周为周期）的习惯，输出一个 JSON 数组。",
      "格式：",
      '```json',
      '[{ "title": "习惯名称", "weekdays": [1,3,5], "timeSlot": "morning|afternoon|evening", "time": "18:30", "reminders": [{ "offsetMinutes": 30, "message": "提醒内容", "channel": "wechat" }] }]',
      '```',
      "",
      "字段说明：weekdays 用 0-6 表示（0=周日），timeSlot 可选，time 可选（精确时间），reminders 可选。",
      "只提取用户明确提到的每周重复习惯，不要凭空推测。",
      "提醒消息要具体实用。",
      existingDesc,
      "",
      "请严格按照以下格式输出（不要有其他内容）：",
      "---PROFILE_START---",
      "（档案内容）",
      "---PROFILE_END---",
      "---ROUTINES_START---",
      "（JSON 数组）",
      "---ROUTINES_END---",
    ].join("\n");

    const summaryMessages = [
      ...messages,
      { role: "user" as const, content: summaryPrompt },
    ];

    const provider = this.getProvider();
    const result = await provider.chat({ messages: summaryMessages, maxTokens: 3000 });
    this.logProviderUsage(memberId, result.usage);
    const text = result.message.content;

    // Parse profile
    const profileMatch = text.match(/---PROFILE_START---([\s\S]*?)---PROFILE_END---/);
    const profile = profileMatch ? profileMatch[1]!.trim() : "";

    // Parse routines
    const routinesMatch = text.match(/---ROUTINES_START---([\s\S]*?)---ROUTINES_END---/);
    let routines: Routine[] = [];
    if (routinesMatch) {
      const jsonMatch = routinesMatch[1]!.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as Array<{
            title: string;
            weekdays: number[];
            timeSlot?: string;
            time?: string;
            reminders?: Array<{ offsetMinutes: number; message: string; channel: string }>;
          }>;
          routines = parsed.map((item) => ({
            id: "",
            title: item.title,
            weekdays: item.weekdays,
            timeSlot: item.timeSlot as Routine["timeSlot"],
            time: item.time,
            reminders: (item.reminders ?? []).map((r) => ({
              offsetMinutes: r.offsetMinutes,
              message: r.message,
              channel: (r.channel as "wechat" | "dashboard" | "both") ?? "wechat",
            })),
          }));
        } catch { /* ignore parse error */ }
      }
    }

    this.interviewSessions.delete(memberId);
    return { profile, routines };
  }

  cancelInterview(memberId: string): void {
    this.interviewSessions.delete(memberId);
  }

  hasActiveInterview(memberId: string): boolean {
    return this.interviewSessions.has(memberId);
  }

  async generateRoutinesFromProfile(memberId: string): Promise<Routine[]> {
    const profile = this.storage.readMemberProfile(memberId);
    if (!profile || profile.trim().length < 10) {
      throw new Error("成员档案内容不足，请先完善档案");
    }

    const existing = this.routineEngine.getRoutines(memberId);
    const existingDesc = existing.length > 0
      ? `\n已有的 7 days 习惯（避免重复）：\n${existing.map((r) => `- ${r.title}`).join("\n")}`
      : "";

    const prompt = [
      "根据以下成员档案，提取其中可以设置为 7 days（以一周为周期）的习惯。",
      "",
      "## 成员档案",
      profile,
      existingDesc,
      "",
      "## 输出要求",
      "输出一个 JSON 数组，每个元素代表一个每周重复的习惯。",
      "格式：",
      '```json',
      '[{ "title": "习惯名称", "weekdays": [1,3,5], "timeSlot": "morning|afternoon|evening", "time": "18:30", "reminders": [{ "offsetMinutes": 30, "message": "提醒内容", "channel": "wechat" }] }]',
      '```',
      "",
      "字段说明：weekdays 用 0-6 表示（0=周日），timeSlot 可选，time 可选（精确时间），reminders 可选。",
      "只提取档案中明确提到的每周重复习惯，不要凭空推测。",
      "提醒消息要具体实用。",
      "只输出 JSON 数组，不要有其他内容。",
    ].join("\n");

    const provider = this.getProvider();
    const result = await provider.chat({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2000,
    });
    this.logProviderUsage(memberId, result.usage);

    const text = result.message.content;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    try {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        title: string;
        weekdays: number[];
        timeSlot?: string;
        time?: string;
        reminders?: Array<{ offsetMinutes: number; message: string; channel: string }>;
      }>;
      return parsed.map((item) => ({
        id: "",
        title: item.title,
        weekdays: item.weekdays,
        timeSlot: item.timeSlot as Routine["timeSlot"],
        time: item.time,
        reminders: (item.reminders ?? []).map((r) => ({
          offsetMinutes: r.offsetMinutes,
          message: r.message,
          channel: (r.channel as "wechat" | "dashboard" | "both") ?? "wechat",
        })),
      }));
    } catch {
      return [];
    }
  }

  async parseRoutineDescription(memberId: string, description: string): Promise<Routine> {
    const member = this.familyManager.getMember(memberId);
    const existing = this.routineEngine.getRoutines(memberId);
    const { display, iso } = this.formatNow();

    const pluginTools = this.pluginHost.getAvailableTools();
    const toolsDesc = pluginTools.length > 0
      ? pluginTools.map((t) => `  - ${t.toolName}（${t.pluginName}）: ${t.description}`).join("\n")
      : "  （暂无已安装插件）";

    const systemPrompt = [
      "你是一个家庭 AI 管家的习惯解析器。用户会用自然语言描述一个生活习惯，你需要将其解析为结构化 JSON。",
      "",
      `当前时间: ${display} (${iso})`,
      member ? `当前成员: ${member.name}` : "",
      "",
      existing.length > 0 ? `已有习惯（避免重复）:\n${existing.map((r) => `- ${r.title} (${r.weekdays.map((d) => ["日","一","二","三","四","五","六"][d]).join("、")}${r.time ? " " + r.time : ""})`).join("\n")}` : "",
      "",
      "# 可用的插件工具（ai_task 类型的 action 在运行时可以调用这些工具）",
      toolsDesc,
      "",
      "# 输出格式",
      "请返回一个 JSON 对象（不要包含 markdown 代码块标记），格式如下：",
      JSON.stringify({
        title: "习惯名称",
        weekdays: [1, 3, 5],
        timeSlot: "morning | afternoon | evening",
        time: "HH:MM",
        actions: [
          { id: "act_xxx", type: "notify", trigger: "before", offsetMinutes: 30, channel: "wechat", message: "提醒内容" },
          { id: "act_yyy", type: "ai_task", trigger: "before", offsetMinutes: 60, channel: "wechat", prompt: "描述 AI 需要执行的任务" },
        ],
      }, null, 2),
      "",
      "# 规则",
      "1. weekdays: 0=周日, 1=周一, ..., 6=周六",
      "2. timeSlot: morning(6-12点), afternoon(12-18点), evening(18点后)",
      "3. time: 24小时制 HH:MM 格式",
      "4. actions 必须包含至少一个 notify 类型（确保用户收到通知）",
      "5. 如果用户描述涉及天气、健身装备、买菜等，生成 ai_task 类型的 action，prompt 中描述任务需求（如「查询明天天气并给出穿衣建议」），运行时 AI 会自动调用对应插件",
      "6. 优先使用 ai_task 而非 plugin 类型，因为 ai_task 更灵活，能综合多个工具",
      "7. 每个 action 的 id 用 act_ 前缀加随机字符串",
      "8. trigger: before=提前, at=准时, after=之后; offsetMinutes 表示提前/延后的分钟数，trigger=at 时 offsetMinutes=0",
      "9. channel: wechat=微信通知, dashboard=看板, both=两者",
      "10. 只返回 JSON，不要有任何其他文字",
    ].filter(Boolean).join("\n");

    const provider = this.getProvider();
    const result = await provider.chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: description },
      ],
      maxTokens: 2000,
    });
    this.logProviderUsage(memberId, result.usage);

    let text = result.message.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI 未能返回有效的 JSON 格式");
    const parsed = JSON.parse(jsonMatch[0]) as {
      title: string;
      weekdays: number[];
      timeSlot?: string;
      time?: string;
      actions?: Array<{
        id?: string;
        type: string;
        trigger: string;
        offsetMinutes: number;
        channel?: string;
        message?: string;
        prompt?: string;
        toolName?: string;
        toolParams?: Record<string, unknown>;
      }>;
    };

    const routine: Routine = {
      id: `rtn_${Date.now().toString(36)}`,
      title: parsed.title,
      weekdays: parsed.weekdays ?? [],
      timeSlot: (parsed.timeSlot as Routine["timeSlot"]) ?? undefined,
      time: parsed.time,
      reminders: [],
      actions: (parsed.actions ?? []).map((a, i) => ({
        id: a.id || `act_${Date.now().toString(36)}_${i}`,
        type: (a.type as "notify" | "plugin" | "ai_task") ?? "notify",
        trigger: (a.trigger as "before" | "at" | "after") ?? "at",
        offsetMinutes: a.offsetMinutes ?? 0,
        channel: (a.channel as "wechat" | "dashboard" | "both") ?? "wechat",
        message: a.message,
        prompt: a.prompt,
        toolName: a.toolName,
        toolParams: a.toolParams,
      })),
    };

    if (!routine.actions!.some((a) => a.type === "notify")) {
      routine.actions!.unshift({
        id: `act_${Date.now().toString(36)}_default`,
        type: "notify",
        trigger: "at",
        offsetMinutes: 0,
        channel: "wechat",
        message: routine.title,
      });
    }

    return routine;
  }

  applyRoutines(memberId: string, routines: Routine[]): void {
    for (const routine of routines) {
      this.routineEngine.setRoutine(memberId, routine);
    }
  }

  async shutdown(): Promise<void> {
    this.actionExecutor.stop();
    this.reminderScheduler.shutdown();
    await this.gateway.stopAll();
    this.db.close();
  }
}
