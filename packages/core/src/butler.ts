import { createProvider } from "@nichijou/ai";
import type { ChatRequest, LLMProvider, StreamEvent } from "@nichijou/ai";
import { 
  MultimodalProviderSelector, 
  createWhisperService,
  type MultimodalProviderConfig 
} from "@nichijou/ai";
import { AgentSession, createAgentSession } from "@nichijou/agent";
import type { AgentEvent } from "@nichijou/agent";
import { getZonedDateTimeParts } from "@nichijou/shared";
import type { 
  FamilyMember, 
  InboundMessage, 
  Message,
  ConversationMessage,
  MultimodalMessage,
  ToolDefinition, 
  Routine, 
  RoutineAction, 
  MediaContent,
  ProcessedMediaInfo,
  ReferenceContent,
  MultimediaConfig
} from "@nichijou/shared";
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
import { createMessageTools } from "./tools/message-tools.js";
import { createDownloadTools } from "./tools/download-tools.js";
import { ReminderScheduler } from "./reminder/reminder-scheduler.js";
import { ActivityReminderScheduler } from "./reminder/activity-reminder.js";
import { PluginHost } from "./plugin-host/plugin-host.js";
import { resolvePluginImportUrl } from "./plugins/resolve-plugin.js";
import { ActionExecutor } from "./routine/action-executor.js";
import { ModelManager } from "./services/model-manager.js";
import { ErrorHandler } from "./services/error-handler.js";
import { SystemLogger } from "./services/system-logger.js";
import type { AgentContext } from "./types/agent.js";

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
  readonly activityReminderScheduler: ActivityReminderScheduler;
  readonly pluginHost: PluginHost;
  readonly actionExecutor: ActionExecutor;
  readonly modelManager: ModelManager;
  readonly systemLogger: SystemLogger;

  private provider: LLMProvider | null = null;
  private sessions = new Map<string, AgentSession>();
  private _wechatChannel: WeChatChannelLike | null = null;
  private interviewSessions = new Map<string, Array<{ role: "user" | "assistant" | "system"; content: string }>>();
  private multimodalSelector?: MultimodalProviderSelector;
  private errorHandler: ErrorHandler;

  constructor(dataDir?: string) {
    this.storage = new StorageManager(dataDir);
    this.config = new ConfigManager(this.storage);
    this.db = new Database(this.storage);
    this.systemLogger = new SystemLogger(this.db);
    this.systemLogger.installConsoleCapture();
    this.familyManager = new FamilyManager(this.storage);
    this.routineEngine = new RoutineEngine(this.storage);
    this.gateway = new Gateway(this.familyManager);
    this.reminderScheduler = new ReminderScheduler(this.db, this.gateway);
    this.activityReminderScheduler = new ActivityReminderScheduler(this.db, this.gateway, this.familyManager);
    this.pluginHost = new PluginHost(this.storage);
    this.modelManager = new ModelManager(this.config, (provider) => this.wrapProviderWithLogging(provider));
    this.actionExecutor = new ActionExecutor(
      this.routineEngine, this.familyManager, this.pluginHost,
      this.gateway, null, this.db, this.config,
    );
    this.actionExecutor.setAiTaskRunner((memberId, routine, action) => this.runRoutineAiTask(memberId, routine, action));

    // 执行配置迁移
    this.modelManager.migrateFromLegacyConfig();

    // 初始化多模态提供商选择器
    this.initializeMultimodalSelector();

    // 初始化错误处理器
    this.errorHandler = new ErrorHandler({
      enableTextFallback: true,
      enableMediaSkip: true,
      enableReferenceFallback: true,
      maxRetries: 3,
      retryDelayMs: 2000,
    });

    this.gateway.onMessage(this.handleMessage.bind(this));
    this.gateway.onUnboundMessage(this.handleUnboundMessage.bind(this));

    // 启动会话持久化
    this.startSessionPersistence();

    // 启动记忆管理
    this.startMemoryManagement();
  }

  /** 仅加载 `~/.nichijou/config.yaml` 中 `plugins` 列出的包（安装目录 ~/.nichijou/plugins） */
  async registerPlugins(): Promise<void> {
    const pluginsDir = this.storage.resolve("plugins");
    const specs = this.config.get().plugins ?? [];
    if (specs.length === 0) {
      console.log(
        "[Plugin] 未配置插件。在 ~/.nichijou/config.yaml 设置 plugins: [\"@nichijou/plugin-weather\"] 或执行 nichijou plugin install <包名>",
      );
      this.refreshAllSessionTools();
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
    this.refreshAllSessionTools();
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
        WeChatChannel: new (storage: StorageManager, database: Database, multimediaConfig: MultimediaConfig) => WeChatChannelLike;
      };
      const channel = new mod.WeChatChannel(this.storage, this.db, this.config.getMultimediaConfig()) as WeChatChannelLike;
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

  getProvider(context?: AgentContext): LLMProvider {
    const timeZone = this.config.get().timezone || "Asia/Shanghai";

    // 如果指定了上下文中的模型ID，优先使用
    if (context?.preferredModelId) {
      const model = this.modelManager.getModelById(context.preferredModelId);
      if (model && model.enabled) {
        return this.wrapProviderWithLogging(createProvider({
          provider: model.provider,
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          model: model.model,
          timeout: model.timeout,
          thinkingMode: model.thinkingMode,
          timeZone,
        }));
      }
    }

    // 如果指定了agent上下文，尝试获取agent绑定的模型
    if (context?.agentId) {
      const agentModel = this.modelManager.getModelForAgent(context.agentId);
      if (agentModel && agentModel.enabled) {
        return this.wrapProviderWithLogging(createProvider({
          provider: agentModel.provider,
          baseUrl: agentModel.baseUrl,
          apiKey: agentModel.apiKey,
          model: agentModel.model,
          timeout: agentModel.timeout,
          thinkingMode: agentModel.thinkingMode,
          timeZone,
        }));
      }
    }

    // 使用新的多模型配置
    const activeModel = this.modelManager.getActiveModel();
    if (activeModel && activeModel.enabled) {
      if (!this.provider) {
        this.provider = this.wrapProviderWithLogging(createProvider({
          provider: activeModel.provider,
          baseUrl: activeModel.baseUrl,
          apiKey: activeModel.apiKey,
          model: activeModel.model,
          timeout: activeModel.timeout,
          thinkingMode: activeModel.thinkingMode,
          timeZone,
        }));
        this.actionExecutor.setProvider(this.provider);
      }
      return this.provider;
    }

    // 回退到旧的配置格式（向后兼容）
    if (!this.provider) {
      const cfg = this.config.get();
      this.provider = this.wrapProviderWithLogging(createProvider({ ...cfg.llm, timeZone }));
      this.actionExecutor.setProvider(this.provider);
    }
    return this.provider;
  }

  wrapProviderWithLogging(provider: LLMProvider): LLMProvider {
    const logger = this.systemLogger;
    const fullLogOptions = {
      fullPayload: true,
      maxJsonLength: null,
      maxStringLength: null,
    };
    const buildLogInput = async (request: ChatRequest, stream: boolean) => {
      const maybeProvider = provider as unknown as {
        buildRequestBody?: (request: ChatRequest, stream: boolean) => Promise<Record<string, unknown>>;
      };
      const redactDataUrls = (value: unknown): unknown => {
        if (typeof value === "string") {
          return value.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "data:image/[REDACTED];base64,[REDACTED]");
        }
        if (Array.isArray(value)) {
          return value.map(redactDataUrls);
        }
        if (value && typeof value === "object") {
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, redactDataUrls(child)]),
          );
        }
        return value;
      };
      if (!maybeProvider.buildRequestBody) {
        return { config: provider.config, request };
      }
      try {
        return {
          config: provider.config,
          request,
          apiRequestBody: redactDataUrls(await maybeProvider.buildRequestBody(request, stream)),
        };
      } catch (error) {
        return {
          config: provider.config,
          request,
          apiRequestBodyError: error instanceof Error ? error.message : String(error),
        };
      }
    };

    return {
      get config() {
        return provider.config;
      },

      async chat(request: ChatRequest) {
        const traceId = logger.createTraceId("llm");
        const startedAt = Date.now();
        const input = await buildLogInput(request, false);
        logger.logRuntime({
          source: "LLM.api",
          message: "LLM API chat started",
          input,
          traceId,
          ...fullLogOptions,
        });

        try {
          const response = await provider.chat(request);
          logger.logRuntime({
            source: "LLM.api",
            message: "LLM API chat completed",
            input,
            output: response,
            durationMs: Date.now() - startedAt,
            traceId,
            ...fullLogOptions,
          });
          return response;
        } catch (error) {
          logger.logError({
            source: "LLM.api",
            message: "LLM API chat failed",
            input,
            error,
            durationMs: Date.now() - startedAt,
            traceId,
            ...fullLogOptions,
          });
          throw error;
        }
      },

      async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
        const traceId = logger.createTraceId("llm_stream");
        const startedAt = Date.now();
        const events: StreamEvent[] = [];
        const input = await buildLogInput(request, true);
        logger.logRuntime({
          source: "LLM.api",
          message: "LLM API stream started",
          input,
          traceId,
          ...fullLogOptions,
        });

        try {
          for await (const event of provider.chatStream(request)) {
            events.push(event);
            yield event;
          }

          const doneEvent = [...events].reverse().find((event) => event.type === "done");
          logger.logRuntime({
            source: "LLM.api",
            message: "LLM API stream completed",
            input,
            output: {
              events,
              final: doneEvent,
            },
            durationMs: Date.now() - startedAt,
            traceId,
            ...fullLogOptions,
          });
        } catch (error) {
          logger.logError({
            source: "LLM.api",
            message: "LLM API stream failed",
            input,
            output: { events },
            error,
            durationMs: Date.now() - startedAt,
            traceId,
            ...fullLogOptions,
          });
          throw error;
        }
      },
    };
  }

  refreshProvider(): void {
    this.provider = null;
    this.sessions.clear();
  }

  private currentMemberId: string | undefined;
  
  // 上下文管理配置
  private readonly MAX_CONTEXT_MESSAGES = 100; // 最大消息数
  private readonly KEEP_RECENT_MESSAGES = 30;   // 保留的最近消息数
  private static readonly SESSION_SUMMARY_TITLE = "# 当前会话摘要";
  
  // 会话持久化配置
  private readonly SESSION_SAVE_INTERVAL = 30 * 1000; // 30秒保存一次会话状态
  private sessionSaveTimer?: NodeJS.Timeout;
  
  // 记忆管理配置
  private readonly MEMORY_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24小时清理一次
  private readonly SUMMARY_GENERATION_INTERVAL = 12 * 60 * 60 * 1000; // 12小时检查一次摘要生成
  private memoryCleanupTimer?: NodeJS.Timeout;
  private summaryGenerationTimer?: NodeJS.Timeout;

  private buildTools(): ToolDefinition[] {
    return [
      ...createFamilyTools(this.familyManager, this.storage),
      ...createRoutineTools(this.routineEngine, this.familyManager),
      ...createMemoryTools(this.storage),
      ...createReminderTools(this.reminderScheduler),
      ...createMessageTools(
        this.gateway,
        this.familyManager,
        this.storage,
        (id) => this.clearMemberSession(id),
        () => this.currentMemberId
      ),
      ...createDownloadTools(this), // 添加下载任务管理工具
      ...this.createDebugTools(), // 添加调试工具
      ...this.pluginHost.getAllTools(),
    ];
  }

  private recordAgentEventLog(
    event: AgentEvent,
    context: {
      flow: string;
      memberId: string;
      traceId: string;
      toolStarts: Map<string, number[]>;
    },
  ): void {
    if (event.type === "tool_start") {
      const starts = context.toolStarts.get(event.toolName) ?? [];
      starts.push(Date.now());
      context.toolStarts.set(event.toolName, starts);
      this.systemLogger.logRuntime({
        source: "Agent.tool",
        message: "Tool call started",
        input: { toolName: event.toolName, params: event.params },
        details: { flow: context.flow, memberId: context.memberId },
        traceId: context.traceId,
      });
      return;
    }

    if (event.type === "tool_end") {
      const starts = context.toolStarts.get(event.toolName) ?? [];
      const startedAt = starts.shift();
      context.toolStarts.set(event.toolName, starts);
      const payload = {
        source: "Agent.tool",
        message: event.isError ? "Tool call failed" : "Tool call completed",
        input: { toolName: event.toolName },
        output: { result: event.result },
        details: { flow: context.flow, memberId: context.memberId },
        durationMs: startedAt ? Date.now() - startedAt : undefined,
        traceId: context.traceId,
      };
      if (event.isError) {
        this.systemLogger.logError({ ...payload, error: { message: event.result } });
      } else {
        this.systemLogger.logRuntime(payload);
      }
      return;
    }

    if (event.type === "turn_end") {
      this.systemLogger.logRuntime({
        source: "Agent.turn",
        message: "Agent turn ended",
        output: { message: event.message },
        details: { flow: context.flow, memberId: context.memberId, usage: event.usage },
        traceId: context.traceId,
      });
      return;
    }

    if (event.type === "error") {
      this.systemLogger.logError({
        source: "Agent.loop",
        message: "Agent loop emitted error",
        details: { flow: context.flow, memberId: context.memberId },
        error: event.error,
        traceId: context.traceId,
      });
    }
  }

  private refreshSessionTools(session: AgentSession): void {
    session.updateTools(this.buildTools());
  }

  private refreshAllSessionTools(): void {
    for (const session of this.sessions.values()) {
      this.refreshSessionTools(session);
    }
  }

  /**
   * 创建调试工具集
   */
  private createDebugTools(): ToolDefinition[] {
    return [
      {
        name: "check_current_time",
        description: "检查和验证系统当前时间和时区设置，用于调试时间相关问题",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
        execute: async () => {
          const now = new Date();
          const configTz = this.config.get().timezone || "Asia/Shanghai";
          
          // 使用多种方式显示时间，便于对比
          const utcTime = now.toISOString();
          const localTime = now.toLocaleString("zh-CN", { timeZone: configTz });
          const systemTime = now.toString();
          
          // 使用Butler的formatNow方法
          const { display, iso } = this.formatNow();
          
          // 详细的时区信息
          const parts = new Intl.DateTimeFormat("zh-CN", {
            timeZone: configTz,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            weekday: "long",
            hour12: false,
          }).formatToParts(now);
          
          const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
          
          const result = {
            butler时间格式: {
              display,
              iso,
            },
            原始时间: {
              utc: utcTime,
              配置时区显示: localTime,
              系统时间: systemTime,
            },
            时区信息: {
              配置时区: configTz,
              系统时区: Intl.DateTimeFormat().resolvedOptions().timeZone,
              系统环境TZ: process.env.TZ || "未设置",
            },
            格式化细节: {
              年: get("year"),
              月: get("month"), 
              日: get("day"),
              星期: get("weekday"),
              时: get("hour"),
              分: get("minute"),
              秒: get("second"),
            },
            timestamp: Date.now(),
            检查时间: new Date().toISOString(),
          };

          return {
            content: `时间检查结果:\n\n${JSON.stringify(result, null, 2)}\n\n如果时间显示不正确，请检查:\n1. 服务器系统时间是否正确\n2. config.yaml中的timezone配置\n3. 是否需要重启服务`
          };
        },
      },
      {
        name: "refresh_system_prompt", 
        description: "强制刷新当前会话的系统提示，用于解决时间或上下文不同步问题",
        parameters: {
          type: "object",
          properties: {
            memberId: { type: "string", description: "要刷新的成员ID" },
          },
          required: ["memberId"],
        },
        execute: async (params) => {
          const memberId = params.memberId as string;
          const session = this.sessions.get(memberId);
          
          if (!session) {
            return { content: `成员 ${memberId} 没有活跃的对话会话`, isError: true };
          }
          
          const member = this.familyManager.getMember(memberId);
          const newSystemPrompt = this.buildSystemPrompt(member ?? undefined);
          
          // 强制更新系统提示
          session.updateSystemPrompt(newSystemPrompt);
          
          const { display, iso } = this.formatNow();
          
          return {
            content: `已强制刷新成员 ${member?.name || memberId} 的系统提示\n\n更新后的时间信息:\n- 显示时间: ${display}\n- ISO时间: ${iso}\n\n如果时间仍然错误，请使用 check_current_time 工具进一步诊断。`
          };
        },
      },
    ];
  }

  clearMemberSession(memberId: string): void {
    this.sessions.delete(memberId);
  }

  clearAllSessions(): void {
    this.sessions.clear();
  }

  /**
   * 管理会话上下文长度，防止消息过多影响性能
   * 保留系统提示和最近的N轮对话，对超出部分进行压缩存储
   */
  private async manageContextLength(session: AgentSession, memberId: string): Promise<void> {
    const messages = session.getMessages();

    if (messages.length <= this.MAX_CONTEXT_MESSAGES) {
      return; // 未超出限制，无需处理
    }

    const baseSystemPrompt = session.state.systemPrompt;
    const baseSystemMessage: Message = { role: "system", content: baseSystemPrompt };
    const existingSummary = this.getSessionSummaryContent(messages);

    // 保留最近的消息（排除系统消息）
    const nonSystemMessages = messages.filter((msg) => msg.role !== "system");
    const recentMessages = nonSystemMessages.slice(-this.KEEP_RECENT_MESSAGES);
    const oldMessages = nonSystemMessages.slice(0, -this.KEEP_RECENT_MESSAGES);

    if (oldMessages.length === 0) {
      return; // 没有需要压缩的旧消息
    }

    const messagesToSummarize = existingSummary
      ? [{ role: "system" as const, content: `${ButlerService.SESSION_SUMMARY_TITLE}\n\n${existingSummary}` }, ...oldMessages]
      : oldMessages;
    const summary = await this.generateConversationSummary(messagesToSummarize, memberId);

    const summaryMessage = this.createSessionSummaryMessage(summary);
    const newMessages = [baseSystemMessage, summaryMessage, ...recentMessages];
    session.replaceMessages(newMessages, baseSystemPrompt);

    console.log(`[ContextManager] 压缩了 ${oldMessages.length} 条历史消息，保留了 ${recentMessages.length} 条最近消息，memberId: ${memberId}`);
  }

  private isSessionSummaryMessage(message: ConversationMessage): boolean {
    return message.role === "system"
      && typeof message.content === "string"
      && message.content.startsWith(ButlerService.SESSION_SUMMARY_TITLE);
  }

  private createSessionSummaryMessage(summary: string): Message {
    return {
      role: "system",
      content: `${ButlerService.SESSION_SUMMARY_TITLE}\n\n${summary.trim()}`,
    };
  }

  private getSessionSummaryContent(messages: ConversationMessage[]): string | null {
    const summary = messages.find((message) => this.isSessionSummaryMessage(message));
    if (!summary) return null;
    return typeof summary.content === "string"
      ? summary.content.slice(ButlerService.SESSION_SUMMARY_TITLE.length).trim()
      : null;
  }

  private normalizeSessionMessages(messages: ConversationMessage[], systemPrompt: string): ConversationMessage[] {
    const summaries: string[] = [];
    const nonSystemMessages: ConversationMessage[] = [];

    for (const message of messages) {
      if (this.isSessionSummaryMessage(message)) {
        const content = typeof message.content === "string"
          ? message.content.slice(ButlerService.SESSION_SUMMARY_TITLE.length).trim()
          : "";
        if (content) summaries.push(content);
        continue;
      }

      if (message.role === "system" && typeof message.content === "string") {
        const legacy = this.extractLegacySessionSummary(message.content);
        if (legacy) summaries.push(legacy);
        continue;
      }

      nonSystemMessages.push(message);
    }

    const normalized: ConversationMessage[] = [{ role: "system", content: systemPrompt }];
    if (summaries.length > 0) {
      normalized.push(this.createSessionSummaryMessage(summaries.join("\n\n")));
    }
    normalized.push(...nonSystemMessages);
    return normalized;
  }

  private extractLegacySessionSummary(content: string): string | null {
    if (!content.startsWith("# 对话历史摘要")) return null;
    const separator = "\n\n---\n\n";
    const separatorIndex = content.indexOf(separator);
    if (separatorIndex < 0) return null;
    return content.slice("# 对话历史摘要".length, separatorIndex).trim() || null;
  }

  /**
   * 生成对话摘要
   */
  private messageContentToText(message: ConversationMessage): string {
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "image_url") return "[图片]";
        if (part.type === "audio") return "[音频]";
        return "[多媒体]";
      })
      .join("\n");
  }

  private async generateConversationSummary(messages: ConversationMessage[], memberId: string): Promise<string> {
    const member = this.familyManager.getMember(memberId);
    const memberName = member?.preferredName || member?.name || "未知成员";
    
    // 构建摘要提示
    let conversationText = "";
    for (const msg of messages) {
      if (this.isSessionSummaryMessage(msg)) {
        conversationText += `既有会话摘要:\n${this.getSessionSummaryContent([msg]) ?? ""}\n`;
        continue;
      }

      const speaker = msg.role === "user"
        ? memberName
        : msg.role === "assistant"
          ? "管家"
          : msg.role === "tool"
            ? "工具结果"
            : "系统";
      conversationText += `${speaker}: ${this.messageContentToText(msg)}\n`;
    }

    const summaryPrompt = `请对以下对话内容生成简洁的摘要，重点保留：
1. 成员的重要偏好和习惯
2. 关键的决定和约定
3. 重要的个人信息更新
4. 需要持续关注的事项

对话内容：
${conversationText}

请用简洁的中文总结，格式为要点列表：`;

    try {
      const provider = this.getProvider();
      const response = await provider.chat({
        messages: [{ role: "user", content: summaryPrompt }],
        temperature: 0.3,
        maxTokens: 500,
      });

      return response.message.content || "对话摘要生成失败";
    } catch (error) {
      console.error(`[ContextManager] 生成对话摘要失败，memberId: ${memberId}`, error);
      return `对话历史摘要（${messages.length}条消息，${new Date().toLocaleDateString()}）`;
    }
  }

  /**
   * 保存单个会话状态到数据库
   */
  private saveSessionState(memberId: string, session: any): void {
    try {
      const messages = session.getMessages();
      const systemPrompt = session.state.systemPrompt;
      this.db.saveSessionState(memberId, messages, systemPrompt);
    } catch (error) {
      console.error(`[SessionPersistence] 保存会话状态失败，memberId: ${memberId}`, error);
    }
  }

  /**
   * 保存所有活跃会话状态
   */
  private saveAllSessionStates(): void {
    console.log(`[SessionPersistence] 正在保存 ${this.sessions.size} 个活跃会话状态`);
    
    for (const [memberId, session] of this.sessions.entries()) {
      this.saveSessionState(memberId, session);
    }
  }

  /**
   * 从数据库恢复会话状态，结合chat_history表的历史记录
   */
  private restoreSessionFromDatabase(memberId: string): AgentSession | null {
    try {
      const sessionData = this.db.getSessionState(memberId);
      
      // 如果没有保存的会话状态，尝试从chat_history恢复
      if (!sessionData) {
        return this.restoreSessionFromChatHistory(memberId);
      }

      // 检查会话状态是否过于陈旧（超过24小时不恢复）
      const updatedAt = new Date(sessionData.updatedAt);
      const now = new Date();
      const hoursSinceUpdate = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60);
      
      if (hoursSinceUpdate > 24) {
        console.log(`[SessionPersistence] 会话状态过于陈旧（${hoursSinceUpdate.toFixed(1)}小时），尝试从chat_history恢复，memberId: ${memberId}`);
        this.db.deleteSessionState(memberId);
        return this.restoreSessionFromChatHistory(memberId);
      }

      // 整合chat_history中的新消息（在会话状态保存后的消息）
      const recentChats = this.db.getRecentChats(memberId, 20);
      const sessionLastUpdate = new Date(sessionData.updatedAt);
      
      // 找出会话状态保存后的新消息
      const newMessages = recentChats
        .filter(chat => new Date(chat.createdAt) > sessionLastUpdate)
        .reverse() // 按时间顺序排列
        .map((chat): Message => ({
          role: chat.role as Message["role"],
          content: chat.content,
        }));

      let finalMessages = sessionData.messages as ConversationMessage[];
      
      if (newMessages.length > 0) {
        console.log(`[SessionPersistence] 发现 ${newMessages.length} 条新的历史消息，整合到会话中，memberId: ${memberId}`);
        finalMessages = [...sessionData.messages, ...newMessages];
      }

      // 创建新的会话并恢复状态
      const member = this.familyManager.getMember(memberId);
      const systemPrompt = this.buildSystemPrompt(member ?? undefined); // 使用最新的系统提示
      finalMessages = this.normalizeSessionMessages(finalMessages, systemPrompt);
      const session = createAgentSession({
        provider: this.getProvider(),
        systemPrompt,
        tools: this.buildTools(),
        messages: finalMessages,
      });

      console.log(`[SessionPersistence] 恢复会话状态成功，总消息数: ${finalMessages.length}，memberId: ${memberId}`);
      return session;

    } catch (error) {
      console.error(`[SessionPersistence] 恢复会话状态失败，memberId: ${memberId}`, error);
      this.db.deleteSessionState(memberId);
      return this.restoreSessionFromChatHistory(memberId);
    }
  }

  /**
   * 从chat_history表恢复会话（用于没有保存会话状态的情况）
   */
  private restoreSessionFromChatHistory(memberId: string): AgentSession | null {
    try {
      const recentChats = this.db.getRecentChats(memberId, 30); // 获取最近30条聊天记录
      
      if (recentChats.length === 0) {
        return null; // 没有历史记录，返回null让系统创建新会话
      }

      // 检查最近的用户消息是否过于陈旧（超过7天不恢复）
      const lastUserMessage = recentChats.find(chat => chat.role === "user");
      if (lastUserMessage) {
        const lastMessageTime = new Date(lastUserMessage.createdAt);
        const now = new Date();
        const daysSinceLastMessage = (now.getTime() - lastMessageTime.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysSinceLastMessage > 7) {
          console.log(`[SessionPersistence] 历史记录过于陈旧（${daysSinceLastMessage.toFixed(1)}天），不恢复，memberId: ${memberId}`);
          return null;
        }
      }

      // 转换为消息格式（按时间倒序，所以需要reverse）
      const messages = recentChats.reverse().map((chat): Message => ({
        role: chat.role as Message["role"],
        content: chat.content,
      }));

      // 添加当前系统提示作为第一条消息
      const member = this.familyManager.getMember(memberId);
      const systemPrompt = this.buildSystemPrompt(member ?? undefined);
      const finalMessages: Message[] = [
        { role: "system" as const, content: systemPrompt },
        ...messages,
      ];

      const session = createAgentSession({
        provider: this.getProvider(),
        systemPrompt,
        tools: this.buildTools(),
        messages: finalMessages,
      });

      console.log(`[SessionPersistence] 从chat_history恢复会话成功，消息数: ${finalMessages.length}，memberId: ${memberId}`);
      return session;

    } catch (error) {
      console.error(`[SessionPersistence] 从chat_history恢复会话失败，memberId: ${memberId}`, error);
      return null;
    }
  }

  /**
   * 启动时恢复所有会话状态
   */
  private restoreAllSessionStates(): void {
    try {
      const allSessionStates = this.db.getAllSessionStates();
      console.log(`[SessionPersistence] 发现 ${allSessionStates.length} 个保存的会话状态`);

      for (const sessionData of allSessionStates) {
        const restoredSession = this.restoreSessionFromDatabase(sessionData.memberId);
        if (restoredSession) {
          this.sessions.set(sessionData.memberId, restoredSession);
        }
      }

      console.log(`[SessionPersistence] 成功恢复 ${this.sessions.size} 个会话`);
    } catch (error) {
      console.error('[SessionPersistence] 恢复会话状态时发生错误', error);
    }
  }

  /**
   * 启动定期会话保存
   */
  private startSessionPersistence(): void {
    // 启动时恢复会话
    this.restoreAllSessionStates();

    // 定期保存会话状态
    this.sessionSaveTimer = setInterval(() => {
      if (this.sessions.size > 0) {
        this.saveAllSessionStates();
      }
    }, this.SESSION_SAVE_INTERVAL);

    console.log(`[SessionPersistence] 已启动会话持久化，保存间隔: ${this.SESSION_SAVE_INTERVAL / 1000}秒`);
  }

  /**
   * 停止会话持久化
   */
  private stopSessionPersistence(): void {
    if (this.sessionSaveTimer) {
      clearInterval(this.sessionSaveTimer);
      this.sessionSaveTimer = undefined;
    }

    // 最后一次保存所有会话
    this.saveAllSessionStates();
    console.log('[SessionPersistence] 已停止会话持久化');
  }

  /**
   * 获取成员最近的记忆摘要
   */
  private getRecentMemorySummary(memberId: string): string | null {
    try {
      const latestSummary = this.db.getLatestSummaryDetail(memberId);
      if (!latestSummary) {
        return null;
      }

      return latestSummary.summary;
    } catch (error) {
      console.error(`[MemorySummary] 获取记忆摘要失败，memberId: ${memberId}`, error);
      return null;
    }
  }

  /**
   * 生成并保存周期性对话摘要
   */
  private async generatePeriodicSummary(memberId: string): Promise<void> {
    try {
      const member = this.familyManager.getMember(memberId);
      if (!member) {
        console.warn(`[MemorySummary] 未找到成员信息，memberId: ${memberId}`);
        return;
      }

      // 获取最新摘要的时间点，确定摘要的起始时间
      const latestSummary = this.db.getLatestSummaryDetail(memberId);
      const startDate = latestSummary 
        ? new Date(latestSummary.periodEnd)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 如果没有摘要，从7天前开始

      const endDate = new Date();

      // 获取时间段内的聊天记录
      const chats = this.db.getChatsByDateRange(memberId, startDate.toISOString(), endDate.toISOString());
      
      if (chats.length < 10) {
        console.log(`[MemorySummary] 对话数量不足（${chats.length}），跳过摘要生成，memberId: ${memberId}`);
        return;
      }

      // 转换为对话文本
      const memberName = member.preferredName || member.name;
      let conversationText = "";
      for (const chat of chats) {
        const speaker = chat.role === "user" ? memberName : "管家";
        conversationText += `${speaker}: ${chat.content}\n`;
      }

      // 生成摘要
      const summary = await this.generateDetailedMemorySummary(conversationText, memberName);

      // 保存摘要
      this.db.saveSummary(memberId, summary, startDate.toISOString(), endDate.toISOString());

      console.log(`[MemorySummary] 为 ${memberName} 生成了周期性摘要，覆盖了 ${chats.length} 条对话`);
    } catch (error) {
      console.error(`[MemorySummary] 生成周期性摘要失败，memberId: ${memberId}`, error);
    }
  }

  /**
   * 生成详细的记忆摘要
   */
  private async generateDetailedMemorySummary(conversationText: string, memberName: string): Promise<string> {
    const summaryPrompt = `作为家庭AI管家，请为与 ${memberName} 的对话生成详细摘要。重点记录：

1. **个人偏好与习惯**：
   - 生活作息偏好
   - 饮食习惯和禁忌
   - 兴趣爱好
   - 工作/学习安排

2. **重要决定与目标**：
   - 近期的重要决定
   - 制定的目标和待办
   - 需要后续跟进的事项

3. **情感状态与关切**：
   - 表达的担忧或困扰
   - 情绪变化和原因
   - 对家庭成员的关心

4. **关键信息更新**：
   - 个人情况的变化
   - 新的联系方式或地址
   - 健康状况更新

对话内容：
${conversationText}

请用简洁明了的中文总结，采用分类要点的格式，避免冗余信息：`;

    try {
      const provider = this.getProvider();
      const response = await provider.chat({
        messages: [{ role: "user", content: summaryPrompt }],
        temperature: 0.3,
        maxTokens: 800,
      });

      return response.message.content || `${memberName} 的对话摘要（生成失败）`;
    } catch (error) {
      console.error(`[MemorySummary] 生成详细摘要失败`, error);
      return `${memberName} 的对话摘要（${new Date().toLocaleDateString()}）`;
    }
  }

  /**
   * 执行记忆清理任务
   */
  private performMemoryCleanup(): void {
    const traceId = this.systemLogger.createTraceId("cleanup");
    const startedAt = Date.now();
    try {
      console.log('[MemoryManager] 开始执行记忆清理任务');
      this.systemLogger.logRuntime({
        source: "MemoryManager",
        message: "Scheduled cleanup started",
        traceId,
      });

      // 只清理已被长期摘要覆盖的30天前聊天记录
      this.db.cleanOldChats(30);

      // 清理7天前的会话状态
      this.db.cleanOldSessionStates(7);

      // 清理90天前的对话日志
      this.db.cleanOldConversationLogs(90);
      
      // 清理超量的对话日志（保留最新10000条）
      this.db.cleanExcessConversationLogs(10000);

      // 清理60天前的token使用记录
      this.db.cleanOldTokenUsage(60);

      // 清理30天前的提醒日志
      this.db.cleanOldReminderLogs(30);

      // 清理60天前的执行日志
      this.db.cleanOldActionExecutionLogs(60);

      // 清理90天前的系统日志，并按类型各保留最新10000条
      this.db.cleanOldSystemLogs("all", 90);
      this.db.cleanExcessSystemLogs("runtime", 10000);
      this.db.cleanExcessSystemLogs("error", 10000);

      console.log('[MemoryManager] 记忆清理任务完成');
      this.systemLogger.logRuntime({
        source: "MemoryManager",
        message: "Scheduled cleanup completed",
        output: { ok: true },
        durationMs: Date.now() - startedAt,
        traceId,
      });
    } catch (error) {
      console.error('[MemoryManager] 记忆清理任务失败', error);
      this.systemLogger.logError({
        source: "MemoryManager",
        message: "Scheduled cleanup failed",
        error,
        durationMs: Date.now() - startedAt,
        traceId,
      });
    }
  }

  /**
   * 检查并生成需要的对话摘要
   */
  private async checkAndGenerateSummaries(): Promise<void> {
    try {
      console.log('[MemoryManager] 开始检查对话摘要生成需求');
      
      const members = this.familyManager.getMembers();
      let generatedCount = 0;

      for (const member of members) {
        try {
          // 获取最新摘要
          const latestSummary = this.db.getLatestSummaryDetail(member.id);
          
          // 确定检查起始时间
          const checkStartTime = latestSummary 
            ? new Date(latestSummary.periodEnd)
            : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

          // 检查是否有足够的新对话需要摘要
          const recentChats = this.db.getChatsByDateRange(
            member.id, 
            checkStartTime.toISOString(), 
            new Date().toISOString()
          );

          // 如果新对话超过20条，或者距离上次摘要超过3天且有超过5条对话，则生成摘要
          const daysSinceLastSummary = latestSummary 
            ? (Date.now() - new Date(latestSummary.periodEnd).getTime()) / (1000 * 60 * 60 * 24)
            : 7;

          const shouldGenerate = recentChats.length >= 20 || 
                                (daysSinceLastSummary >= 3 && recentChats.length >= 5);

          if (shouldGenerate) {
            await this.generatePeriodicSummary(member.id);
            generatedCount++;
            
            // 避免同时生成太多摘要，添加短暂延迟
            if (generatedCount % 3 === 0) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        } catch (error) {
          console.error(`[MemoryManager] 为成员 ${member.id} 生成摘要时出错`, error);
        }
      }

      if (generatedCount > 0) {
        console.log(`[MemoryManager] 生成了 ${generatedCount} 个对话摘要`);
      } else {
        console.log('[MemoryManager] 无需生成新的对话摘要');
      }
    } catch (error) {
      console.error('[MemoryManager] 检查摘要生成时出错', error);
    }
  }

  /**
   * 启动记忆管理调度器
   */
  private startMemoryManagement(): void {
    // 启动时立即执行一次清理（延迟5分钟避免影响启动）
    setTimeout(() => {
      this.performMemoryCleanup();
    }, 5 * 60 * 1000);

    // 启动时延迟30分钟执行摘要检查，避免启动时负载过高
    setTimeout(() => {
      this.checkAndGenerateSummaries();
    }, 30 * 60 * 1000);

    // 定期清理任务（每24小时）
    this.memoryCleanupTimer = setInterval(() => {
      this.performMemoryCleanup();
    }, this.MEMORY_CLEANUP_INTERVAL);

    // 定期摘要生成检查（每12小时）
    this.summaryGenerationTimer = setInterval(() => {
      this.checkAndGenerateSummaries();
    }, this.SUMMARY_GENERATION_INTERVAL);

    console.log('[MemoryManager] 已启动记忆管理调度器');
  }

  /**
   * 停止记忆管理调度器
   */
  private stopMemoryManagement(): void {
    if (this.memoryCleanupTimer) {
      clearInterval(this.memoryCleanupTimer);
      this.memoryCleanupTimer = undefined;
    }

    if (this.summaryGenerationTimer) {
      clearInterval(this.summaryGenerationTimer);
      this.summaryGenerationTimer = undefined;
    }

    console.log('[MemoryManager] 已停止记忆管理调度器');
  }

  getAllToolDescriptions(): Array<{ source: string; name: string; description: string; parameters: Record<string, unknown> }> {
    const result: Array<{ source: string; name: string; description: string; parameters: Record<string, unknown> }> = [];
    const coreTools = [
      ...createFamilyTools(this.familyManager, this.storage),
      ...createRoutineTools(this.routineEngine, this.familyManager),
      ...createMemoryTools(this.storage),
      ...createReminderTools(this.reminderScheduler),
      ...createMessageTools(this.gateway, this.familyManager, this.storage, () => {}),
    ];
    for (const t of coreTools) {
      result.push({ source: "core", name: t.name, description: t.description, parameters: t.parameters });
    }
    for (const plugin of this.pluginHost.getAllPlugins()) {
      for (const t of plugin.tools) {
        result.push({ source: `plugin:${plugin.id}`, name: t.name, description: t.description, parameters: t.parameters });
      }
    }
    return result;
  }

  async executeTool(toolName: string, params: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
    for (const plugin of this.pluginHost.getAllPlugins()) {
      if (plugin.tools.some((t) => t.name === toolName)) {
        if (!this.pluginHost.isEnabled(plugin.id)) {
          return { content: `Tool disabled: ${toolName}`, isError: true };
        }
        return this.pluginHost.executeTool(toolName, params);
      }
    }
    const coreTools = [
      ...createFamilyTools(this.familyManager, this.storage),
      ...createRoutineTools(this.routineEngine, this.familyManager),
      ...createMemoryTools(this.storage),
      ...createReminderTools(this.reminderScheduler),
      ...createMessageTools(this.gateway, this.familyManager, this.storage, (id: string) => this.clearMemberSession(id)),
    ];
    const tool = coreTools.find((t) => t.name === toolName);
    if (!tool) return { content: `工具 "${toolName}" 不存在`, isError: true };
    return tool.execute(params);
  }

  /**
   * 测试习惯Action的执行（用于调试和验证）
   */
  async testRoutineAction(
    memberId: string, 
    routineId: string, 
    actionId: string
  ): Promise<{ success: boolean; result: string; errors?: string[] }> {
    try {
      // 获取习惯和action
      const routine = this.routineEngine.getRoutines(memberId).find(r => r.id === routineId);
      if (!routine) {
        return {
          success: false,
          result: `习惯不存在: ${routineId}`
        };
      }

      const action = routine.actions?.find(a => a.id === actionId);
      if (!action) {
        return {
          success: false,
          result: `Action不存在: ${actionId}`
        };
      }

      // 使用ActionExecutor进行测试
      return await this.actionExecutor.testAction(memberId, routine, action);

    } catch (error) {
      console.error(`[Butler] 测试Action失败:`, error);
      return {
        success: false,
        result: `测试失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
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

      // 添加历史对话摘要
      const recentSummary = this.getRecentMemorySummary(member.id);
      if (recentSummary) {
        prompt += `# 历史对话要点\n\n${recentSummary}\n\n---\n\n`;
      }

      const today = new Date();
      const tz = this.config.get().timezone || "Asia/Shanghai";
      const schedule = this.routineEngine.resolveDaySchedule(member.id, today, tz);
      if (schedule.items.length > 0) {
        prompt += `# 今日安排\n\n`;
        for (const item of schedule.items) {
          prompt += `- ${item.timeSlot ?? ""} ${item.title}\n`;
        }
        prompt += "\n---\n\n";
      }
    }
    const family = this.familyManager.getFamily();
    if (family?.homeAdcode || family?.homeCity) {
      prompt += `# 家庭常居地\n\n`;
      prompt += `优先位置参数：${family.homeAdcode ?? family.homeCity}\n`;
      prompt += `当调用天气相关插件工具且用户未提供城市时，优先使用此位置。\n\n---\n\n`;
    }

    // 添加家庭成员列表（包含昵称信息）
    const members = this.familyManager.getMembers();
    if (members.length > 0) {
      prompt += `# 家庭成员列表\n\n`;
      for (const memberInfo of members) {
        const displayName = memberInfo.preferredName || memberInfo.name;
        let memberLine = `- ${displayName} (ID: ${memberInfo.id})`;
        
        // 添加角色信息
        if (memberInfo.role === "admin") {
          memberLine += ` [管理员]`;
        }
        
        // 从档案中解析昵称
        const profile = this.storage.readMemberProfile(memberInfo.id);
        const aliases: string[] = [];
        
        // 从FamilyMember.aliases字段获取昵称
        if (memberInfo.aliases && memberInfo.aliases.length > 0) {
          aliases.push(...memberInfo.aliases);
        }
        
        // 从档案中解析昵称
        if (profile) {
          const aliasMatch = profile.match(/[-•]\s*昵称[\/别名]*\s*[:：]\s*([^\n\r]+)/i);
          if (aliasMatch && aliasMatch[1] && aliasMatch[1].trim() !== "（如：妈妈、爸爸、小明等，用逗号分隔多个昵称）") {
            const aliasText = aliasMatch[1].trim();
            const profileAliases = aliasText.split(/[,，;；、]\s*/).filter(alias => alias.trim());
            aliases.push(...profileAliases);
          }
        }
        
        // 去重并添加昵称信息
        const uniqueAliases = [...new Set(aliases)];
        if (uniqueAliases.length > 0) {
          memberLine += ` (别名: ${uniqueAliases.join(', ')})`;
        }
        
        prompt += `${memberLine}\n`;
      }
      prompt += `\n`;
      
      // 强调当前对话成员
      const currentDisplayName = member?.preferredName || member?.name;
      prompt += `**当前对话成员**: ${currentDisplayName} (ID: ${member?.id ?? "未知"})\n\n---\n\n`;
    }

    prompt += `# 功能说明\n\n你有以下工具可以使用来帮助家庭成员管理生活。请根据对话自然地调用工具。\n`;
    prompt += `\n重要提示：当需要操作其他家庭成员时，请优先使用 resolve_member 工具通过姓名或昵称查找准确的成员ID。\n`;

    prompt += `\n# 消息与提醒使用规则\n\n`;
    prompt += `严格按以下规则选择 send_message 或 create_reminder 工具：\n\n`;
    prompt += `## send_message 工具使用场景：\n`;
    prompt += `- 立即发送给其他家庭成员 → 使用 send_message\n`;
    prompt += `- 关键词：「现在告诉XX」「马上发给XX」「立即通知XX」「告诉他」\n`;
    prompt += `- 用途：通知他人、转发结果、跨成员传话\n\n`;
    prompt += `## create_reminder 工具使用场景：\n`;
    prompt += `- 在未来特定时间提醒自己 → 使用 create_reminder\n`;
    prompt += `- 关键词：「明天XX时提醒我」「下午X点提醒我」「X分钟后提醒我」\n`;
    prompt += `- 用途：个人定时提醒、延时任务\n\n`;
    prompt += `## 重要判断原则：\n`;
    prompt += `1. 立即性 + 他人 = send_message\n`;
    prompt += `2. 未来时间 + 自己 = create_reminder\n`;
    prompt += `3. 创建提醒的强制流程：\n`;
    prompt += `   - 先调用 confirm_reminder_time 确认时间理解\n`;
    prompt += `   - 等用户明确确认后，再调用 create_reminder\n`;
    prompt += `   - 绝不跳过时间确认步骤！\n\n`;

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

  private buildRoutineAiTaskSystemPrompt(member: FamilyMember, routine: Routine): string {
    const { display, iso } = this.formatNow();
    let prompt = [
      "你是家庭 AI 管家，正在执行一个 7 days 定时习惯任务。",
      "这是一次全新的独立执行上下文，不包含成员的历史聊天记录。",
      "如果任务需要实时信息、外部数据或项目内数据，必须调用可用工具获取，不要伪造工具结果。",
      "所有可用工具已通过 tools schema 提供；可按需多次调用工具，直到任务完成。",
      "最终只返回要发送给用户的结果文本。不要调用消息发送类工具给当前用户发送最终结果，系统会在后续 notify action 中统一发送微信通知。",
      "除非任务内容明确要求通知其他家庭成员，否则不要调用 send_message。",
      "不要调用 clear_context，除非任务内容明确要求清除上下文。",
      "",
      "# 当前时间",
      `现在是 ${display}`,
      `ISO: ${iso}`,
      "请根据此精确时间推算任务中涉及的具体日期时间。",
      "",
      "# 当前成员",
      `成员 ID: ${member.id}`,
      `成员名称: ${member.preferredName || member.name}`,
    ].join("\n");

    const profile = (this.storage.readMemberProfile(member.id) ?? "").trim();
    if (profile) {
      prompt += `\n\n# 成员档案\n${profile}`;
    }

    const family = this.familyManager.getFamily();
    if (family?.homeAdcode || family?.homeCity) {
      prompt += "\n\n# 家庭常居地\n";
      prompt += `优先位置参数：${family.homeAdcode ?? family.homeCity}\n`;
      prompt += "当调用天气相关插件工具且用户未提供城市时，优先使用此位置。";
    }

    const tz = this.config.get().timezone || "Asia/Shanghai";
    const schedule = this.routineEngine.resolveDaySchedule(member.id, new Date(), tz);
    if (schedule.items.length > 0) {
      prompt += "\n\n# 今日安排\n";
      for (const item of schedule.items) {
        const itemTime = item.time ?? item.timeSlot ?? "";
        prompt += `- ${itemTime} ${item.title}\n`;
      }
    }

    prompt += `\n\n# 当前定时习惯\n习惯名称: ${routine.title}`;
    return prompt;
  }

  async runRoutineAiTask(memberId: string, routine: Routine, action: RoutineAction): Promise<string> {
    const member = this.familyManager.getMember(memberId);
    if (!member) {
      throw new Error(`成员不存在: ${memberId}`);
    }
    const taskPrompt = action.prompt?.trim();
    if (!taskPrompt) {
      throw new Error("ai_task prompt 为空");
    }

    const previousMemberId = this.currentMemberId;
    this.currentMemberId = memberId;

    const session = createAgentSession({
      provider: this.getProvider(),
      systemPrompt: this.buildRoutineAiTaskSystemPrompt(member, routine),
      tools: this.buildTools(),
      temperature: 0.3,
    });

    const model = this.config.get().llm.model;
    let lastTurnText = "";
    let agentError: Error | null = null;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_end") {
        if (event.message.content?.trim()) {
          lastTurnText = event.message.content.trim();
        }
        if (event.usage) {
          this.db.logTokenUsage(memberId, event.usage.promptTokens, event.usage.completionTokens, model);
        }
      } else if (event.type === "error") {
        agentError = event.error;
      }
    });

    try {
      const fullResponse = await session.prompt([
        "# 定时任务内容",
        taskPrompt,
        "",
        "请完成以上任务。需要工具时先调用工具；任务完成后只输出最终要发送给用户的结果。",
      ].join("\n"));
      if (agentError) {
        throw agentError;
      }
      const result = (lastTurnText || fullResponse).trim();
      if (!result) {
        throw new Error("AI 任务未返回最终结果");
      }
      return result;
    } finally {
      unsubscribe();
      this.currentMemberId = previousMemberId;
    }
  }

  getOrCreateSession(memberId: string, isOnboarding = false): AgentSession {
    if (!isOnboarding) {
      const existing = this.sessions.get(memberId);
      if (existing) {
        this.refreshSessionTools(existing);
        return existing;
      }

      // 尝试从数据库恢复会话
      const restored = this.restoreSessionFromDatabase(memberId);
      if (restored) {
        this.refreshSessionTools(restored);
        this.sessions.set(memberId, restored);
        return restored;
      }
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
  async chat(memberId: string, input: string, onEvent?: (event: AgentEvent) => void, traceId?: string): Promise<string> {
    // 设置当前成员ID供工具使用
    this.currentMemberId = memberId;

    const session = this.getOrCreateSession(memberId);
    const member = this.familyManager.getMember(memberId);
    
    // 强制更新系统提示以确保时间信息是最新的
    session.updateSystemPrompt(this.buildSystemPrompt(member ?? undefined));
    this.refreshSessionTools(session);
    
    const model = this.config.get().llm.model;
    const activeTraceId = traceId ?? this.systemLogger.createTraceId("chat");
    const startedAt = Date.now();
    const events: Array<{ type: string; data: unknown }> = [];
    const toolStarts = new Map<string, number[]>();

    this.systemLogger.logRuntime({
      source: "Butler.chat",
      message: "Dashboard chat started",
      input: { memberId, message: input },
      details: { model },
      traceId: activeTraceId,
    });

    const unsub = session.subscribe((event) => {
      events.push({ type: event.type, data: event });
      this.recordAgentEventLog(event, {
        flow: "dashboard_chat",
        memberId,
        traceId: activeTraceId,
        toolStarts,
      });
      if (event.type === "turn_end" && event.usage) {
        this.db.logTokenUsage(memberId, event.usage.promptTokens, event.usage.completionTokens, model);
      }
    });

    let unsubExternal: (() => void) | undefined;
    if (onEvent) {
      unsubExternal = session.subscribe(onEvent);
    }

    try {
      const response = await session.prompt(input);
      this.db.saveChat(memberId, "user", input);
      this.db.saveChat(memberId, "assistant", response);
      this.db.saveConversationLogWithMedia(
        memberId,
        member?.name ?? memberId,
        input,
        response,
        JSON.stringify(events),
        [],
        [],
      );
      
      // 智能上下文长度管理
      try {
        await this.manageContextLength(session, memberId);
      } catch (error) {
        console.error(`[ContextManager] 上下文管理失败，memberId: ${memberId}`, error);
      }

      this.systemLogger.logRuntime({
        source: "Butler.chat",
        message: "Dashboard chat completed",
        input: { memberId, message: input },
        output: { response },
        details: { model, eventCount: events.length },
        durationMs: Date.now() - startedAt,
        traceId: activeTraceId,
      });
      
      return response;
    } catch (error) {
      this.systemLogger.logError({
        source: "Butler.chat",
        message: "Dashboard chat failed",
        input: { memberId, message: input },
        details: { model, eventCount: events.length },
        error,
        durationMs: Date.now() - startedAt,
        traceId: activeTraceId,
      });
      throw error;
    } finally {
      unsub();
      unsubExternal?.();
    }
  }

  private static readonly FINISH_KEYWORDS = ["好了", "完成", "没有了", "差不多了", "就这些", "结束", "可以了", "完成了", "no more", "done"];

  /**
   * Start typing indicator for a member if the channel supports it.
   */
  private async startTyping(memberId: string): Promise<void> {
    try {
      // Check if typing indicator is enabled in config
      const config = this.config.get();
      if (!config.wechat?.typingIndicator?.enabled) {
        return;
      }

      const member = this.familyManager.getMember(memberId);
      if (!member) return;

      const channelId = member.primaryChannel && this.gateway.hasChannel(member.primaryChannel)
        ? member.primaryChannel
        : (member.channelBindings.wechat ? "wechat" : "");
      
      if (!channelId) return;

      const channel = this.gateway.getChannel(channelId);
      if (channel?.startTyping) {
        await channel.startTyping(memberId);
      }
    } catch (err) {
      console.error(`[Butler] startTyping 失败 (${memberId}):`, err);
    }
  }

  /**
   * Stop typing indicator for a member if the channel supports it.
   */
  private async stopTyping(memberId: string): Promise<void> {
    try {
      // Check if typing indicator is enabled in config
      const config = this.config.get();
      if (!config.wechat?.typingIndicator?.enabled) {
        return;
      }

      const member = this.familyManager.getMember(memberId);
      if (!member) return;

      const channelId = member.primaryChannel && this.gateway.hasChannel(member.primaryChannel)
        ? member.primaryChannel
        : (member.channelBindings.wechat ? "wechat" : "");
      
      if (!channelId) return;

      const channel = this.gateway.getChannel(channelId);
      if (channel?.stopTyping) {
        await channel.stopTyping(memberId);
      }
    } catch (err) {
      console.error(`[Butler] stopTyping 失败 (${memberId}):`, err);
    }
  }

  /**
   * 初始化多模态提供商选择器
   */
  private initializeMultimodalSelector(): void {
    try {
      const multimediaConfig = this.config.getMultimediaConfig();
      const baseProvider = this.getProvider();
      
      if (!baseProvider) {
        console.warn('[Butler] 无法初始化多模态选择器：基础提供商未设置');
        return;
      }

      // 创建转录服务（如果配置了 OpenAI API Key）
      let transcriptionService;
      const llmConfig = this.config.get().llm;
      if (llmConfig.apiKey && (llmConfig.baseUrl.includes('openai') || llmConfig.baseUrl.includes('api.openai.com'))) {
        transcriptionService = createWhisperService({
          apiKey: llmConfig.apiKey,
          baseUrl: llmConfig.baseUrl.replace('/v1', ''),
        });
      }

      const multimodalConfig: MultimodalProviderConfig = {
        providers: {
          openai: baseProvider,
          claude: baseProvider, // 如果需要支持 Claude，这里可以配置专门的 Claude 提供商
        },
        multimedia: multimediaConfig,
        transcriptionService,
      };

      this.multimodalSelector = new MultimodalProviderSelector(multimodalConfig);
      console.log('[Butler] 多模态提供商选择器初始化成功');
    } catch (error) {
      console.error('[Butler] 初始化多模态选择器失败:', error);
    }
  }

  /**
   * 构建包含多媒体和引用上下文的增强消息
   */
  private async buildEnhancedMessage(
    msg: InboundMessage,
  ): Promise<{ message: string; processedMedia: ProcessedMediaInfo[]; modelMedia: MediaContent[] }> {
    let enhancedMessage = "";
    const processedMedia: ProcessedMediaInfo[] = [];
    const modelMedia: MediaContent[] = [];

    // 处理引用消息上下文
    if (msg.references && msg.references.length > 0) {
      enhancedMessage += this.buildReferenceContext(msg.references);
      enhancedMessage += '\n\n';
    }

    // 处理媒体内容
    if (msg.mediaContent && msg.mediaContent.length > 0) {
      const { context: mediaContext, processedMedia: fromMedia, modelMedia: fromModelMedia } = await this.buildMediaContext(msg.mediaContent);
      processedMedia.push(...fromMedia);
      modelMedia.push(...fromModelMedia);
      if (mediaContext) {
        enhancedMessage += mediaContext + '\n\n';
      }
    }

    // 添加用户文本消息
    enhancedMessage += msg.text;

    return { message: enhancedMessage, processedMedia, modelMedia };
  }

  /**
   * 构建引用消息的上下文
   */
  private buildReferenceContext(references: ReferenceContent[]): string {
    return this.buildSimpleReferenceContext(references);
  }

  /**
   * 构建简单的引用消息上下文（回退方案）
   */
  private buildSimpleReferenceContext(references: ReferenceContent[]): string {
    let context = '[引用消息上下文]\n';
    
    for (const ref of references) {
      context += `- 引用消息: "${ref.content}"\n`;
      
      if (ref.mediaContent && ref.mediaContent.length > 0) {
        for (const media of ref.mediaContent) {
          context += `  - 包含${media.type}文件: ${media.originalName || '未知文件'}\n`;
        }
      }
    }
    
    return context;
  }

  /**
   * 构建媒体内容的上下文描述
   */
  private async buildMediaContext(
    mediaContent: MediaContent[],
  ): Promise<{ context: string; processedMedia: ProcessedMediaInfo[]; modelMedia: MediaContent[] }> {
    const processedMedia: ProcessedMediaInfo[] = [];
    const modelMedia: MediaContent[] = [];
    let context = '[媒体内容]\n';

    for (let index = 0; index < mediaContent.length; index++) {
      const media = mediaContent[index];
      const mediaId = media.hash || media.filePath || `media-${index}`;

      switch (media.type) {
        case 'image':
          context += `- 图片: ${media.originalName || '未知图片'}\n`;
          if (media.filePath) {
            modelMedia.push(media);
          }
          break;
          
        case 'voice':
          context += `- 语音: ${media.originalName || '未知语音'}`;
          if (media.duration) {
            context += ` (时长: ${media.duration}秒)`;
          }
          context += '\n';
          
          // 如果配置了语音转录，尝试转录
          if (this.multimodalSelector) {
            try {
              const transcription = await this.transcribeVoice(media);
              if (transcription) {
                context += `  转录内容: ${transcription}\n`;
                processedMedia.push({
                  mediaId,
                  processType: 'transcription',
                  result: transcription,
                  success: true,
                });
              }
            } catch (error) {
              console.error('[Butler] 语音转录失败:', error);
              context += `  (语音转录失败)\n`;
              processedMedia.push({
                mediaId,
                processType: 'transcription',
                result: '',
                success: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          break;
          
        case 'file':
          context += `- 文件: ${media.originalName || '未知文件'}`;
          if (media.size) {
            const sizeMB = (media.size / 1024 / 1024).toFixed(2);
            context += ` (${sizeMB}MB)`;
          }
          context += '\n';
          break;
          
        case 'video':
          context += `- 视频: ${media.originalName || '未知视频'}`;
          if (media.duration) {
            context += ` (时长: ${media.duration}秒)`;
          }
          context += '\n';
          break;
      }
    }
    
    return { context, processedMedia, modelMedia };
  }

  private supportsImageUnderstanding(): boolean {
    const activeModel = this.modelManager.getActiveModel();
    const cfg = activeModel
      ? {
          provider: activeModel.provider,
          baseUrl: activeModel.baseUrl,
          model: activeModel.model,
        }
      : {
          provider: undefined,
          baseUrl: this.config.get().llm.baseUrl,
          model: this.config.get().llm.model,
        };

    const provider = cfg.provider?.toLowerCase() ?? "";
    const baseUrl = cfg.baseUrl.toLowerCase();
    const model = cfg.model.toLowerCase();

    if (provider === "deepseek" || baseUrl.includes("deepseek.com")) {
      return false;
    }
    if (provider.includes("openai") || baseUrl.includes("api.openai.com")) {
      return /(^|[-_.])gpt-4o|gpt-4\.1|gpt-4-turbo|o[34](-|$)|vision/.test(model);
    }
    return /vision|vl|qwen.*vl|llava|gpt-4o|gpt-4\.1|gpt-4-turbo|gemini|claude-3|o[34](-|$)/.test(model);
  }

  private imageUnsupportedMessage(): string {
    return "当前模型不支持图片理解。请在模型设置中切换到支持视觉输入的模型后，再发送图片。";
  }

  private createPromptInput(message: string, modelMedia: MediaContent[]): string | MultimodalMessage {
    if (modelMedia.length === 0) return message;
    return {
      role: "user",
      content: message,
      media: modelMedia,
    };
  }

  /**
   * 转录语音文件
   */
  private async transcribeVoice(media: MediaContent): Promise<string | null> {
    if (!this.multimodalSelector) {
      return null;
    }

    const config = this.config.getMultimediaConfig();
    if (config.voice_processing.strategy === 'multimodal_native') {
      // 多模态原生处理，不需要预转录
      return null;
    }

    // 使用转录服务（失败时向外抛出，供 buildMediaContext 记录 processedMedia）
    const transcriptionService = (this.multimodalSelector as any).config?.transcriptionService;
    if (!transcriptionService) {
      return null;
    }

    return await transcriptionService.transcribe(
      media.filePath,
      config.voice_processing.transcription_language
    );
  }

  /**
   * 获取当前成员ID（供工具使用）
   */
  getCurrentMemberId(): string {
    return this.currentMemberId || "";
  }

  private formatAdminErrorMessage(error: Error): string {
    const rawError = error.stack || `${error.name}: ${error.message}`;
    const redacted = this.redactSensitiveErrorText(rawError);
    const maxLength = 3500;
    return redacted.length > maxLength
      ? `${redacted.slice(0, maxLength)}\n...`
      : redacted;
  }

  private redactSensitiveErrorText(text: string): string {
    return text
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[REDACTED]")
      .replace(/(api[_-]?key["'\s:=]+)[^"'\s,}]+/gi, "$1[REDACTED]")
      .replace(/(authorization["'\s:=]+)[^"'\s,}]+/gi, "$1[REDACTED]");
  }

  /**
   * 发送错误消息。管理员收到内部错误详情，普通成员收到友好提示。
   */
  private async sendErrorMessage(member: FamilyMember, error: Error): Promise<void> {
    if (member.role === "admin") {
      try {
        await this.gateway.sendToMember(member.id, this.formatAdminErrorMessage(error));
      } catch (sendErr) {
        console.error(`Failed to send admin error message to member ${member.id}:`, sendErr);
      }
      return;
    }

    const errorMessage = error.message;
    let userFriendlyMessage = "抱歉，处理您的消息时出现了问题。";
    
    // 针对特定错误类型提供更有用的信息
    if (errorMessage.includes('LLM_ERROR')) {
      userFriendlyMessage += "大模型服务暂时不可用，请稍后重试。";
    } else if (errorMessage.includes('AbortError') || errorMessage.includes('timeout')) {
      userFriendlyMessage += "请求超时，请稍后重试。";
    } else if (errorMessage.includes('tool_calls')) {
      userFriendlyMessage += "工具调用出现问题，但您可以继续其他对话。";
    } else if (errorMessage.includes('media') || errorMessage.includes('multimodal')) {
      userFriendlyMessage += "多媒体处理出现问题，已切换到文本模式。";
    } else {
      userFriendlyMessage += "请稍后重试或联系管理员。";
    }
    
    try {
      await this.gateway.sendToMember(member.id, userFriendlyMessage);
    } catch (sendErr) {
      console.error(`Failed to send error message to member ${member.id}:`, sendErr);
    }
  }

  private static mergeProcessedMediaInfo(
    a: ProcessedMediaInfo[],
    b: ProcessedMediaInfo[],
  ): ProcessedMediaInfo[] {
    const map = new Map<string, ProcessedMediaInfo>();
    const key = (p: ProcessedMediaInfo) => `${p.mediaId}\0${p.processType}`;
    for (const p of a) map.set(key(p), p);
    for (const p of b) map.set(key(p), p);
    return [...map.values()];
  }

  /**
   * 从事件流中提取媒体处理信息（可与流水线侧采集的转录结果合并）
   */
  private extractProcessedMediaInfo(
    events: Array<{ type: string; data: unknown }>,
    _mediaContent: MediaContent[],
  ): ProcessedMediaInfo[] {
    const processed: ProcessedMediaInfo[] = [];

    events.forEach((event, index) => {
      if (event.type === "transcription_complete") {
        const data = event.data as { mediaId?: string; transcription?: string } | undefined;
        processed.push({
          mediaId: data?.mediaId || `media-${index}`,
          processType: "transcription",
          result: data?.transcription || "",
          success: true,
        });
      }

      if (event.type === "transcription_failed") {
        const data = event.data as { mediaId?: string; error?: string } | undefined;
        processed.push({
          mediaId: data?.mediaId || `media-${index}`,
          processType: "transcription",
          result: "",
          success: false,
          error: data?.error || "转录失败",
        });
      }
    });

    return processed;
  }

  /**
   * Handle an inbound WeChat/channel message.
   * If the member has an active interview, route to the interview flow.
   * Otherwise, normal agent session.
   */
  private async handleMessage(member: FamilyMember, msg: InboundMessage): Promise<void> {
    // 设置当前成员ID供工具使用
    this.currentMemberId = member.id;
    
    // Slash commands (admin only)
    if (msg.text.startsWith("/")) {
      try {
        const reply = await this.handleSlashCommand(member, msg.text);
        await this.gateway.sendToMember(member.id, reply);
      } catch (error) {
        await this.sendErrorMessage(member, error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    // Route to interview if active
    if (this.hasActiveInterview(member.id)) {
      try {
        await this.handleInterviewMessage(member, msg.text);
      } catch (error) {
        await this.sendErrorMessage(member, error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    // Start typing indicator
    await this.startTyping(member.id);

    const traceId = this.systemLogger.createTraceId("wechat");
    const startedAt = Date.now();
    this.systemLogger.logRuntime({
      source: "Butler.handleMessage",
      message: "Inbound member message received",
      input: {
        memberId: member.id,
        memberName: member.name,
        text: msg.text,
        mediaCount: msg.mediaContent?.length ?? 0,
        referenceCount: msg.references?.length ?? 0,
      },
      traceId,
    });

    const session = this.getOrCreateSession(member.id);
    
    // 统一系统提示刷新机制：每轮对话前更新系统提示
    // 确保与Web路径（chat方法）行为一致
    session.updateSystemPrompt(this.buildSystemPrompt(member));

    // 构建包含多媒体上下文的消息
    const mediaStartedAt = Date.now();
    let enhancedMessage = "";
    let pipelineProcessed: ProcessedMediaInfo[] = [];
    let modelMedia: MediaContent[] = [];
    try {
      const builtMessage = await this.buildEnhancedMessage(msg);
      enhancedMessage = builtMessage.message;
      pipelineProcessed = builtMessage.processedMedia;
      modelMedia = builtMessage.modelMedia;
    } catch (error) {
      this.systemLogger.logError({
        source: "Butler.handleMessage",
        message: "Enhanced message build failed",
        input: { text: msg.text, mediaContent: msg.mediaContent, references: msg.references },
        error,
        durationMs: Date.now() - mediaStartedAt,
        traceId,
      });
      await this.stopTyping(member.id);
      await this.sendErrorMessage(member, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.systemLogger.logRuntime({
      source: "Butler.handleMessage",
      message: "Enhanced message built",
      input: { text: msg.text, mediaContent: msg.mediaContent, references: msg.references },
      output: { enhancedMessage, processedMedia: pipelineProcessed },
      durationMs: Date.now() - mediaStartedAt,
      traceId,
    });

    const model = this.config.get().llm.model;

    if (modelMedia.length > 0 && !this.supportsImageUnderstanding()) {
      const reply = this.imageUnsupportedMessage();
      await this.stopTyping(member.id);
      await this.gateway.sendToMember(member.id, reply);
      this.systemLogger.logRuntime({
        source: "Butler.handleMessage",
        message: "Image message rejected because active model does not support vision",
        input: { memberId: member.id, mediaCount: modelMedia.length },
        details: { model },
        traceId,
      });
      this.db.saveConversationLogWithMedia(
        member.id,
        member.name,
        msg.text,
        reply,
        JSON.stringify([]),
        msg.mediaContent || [],
        pipelineProcessed,
      );
      this.db.saveChat(member.id, "user", msg.text);
      this.db.saveChat(member.id, "assistant", reply);
      return;
    }

    const events: Array<{ type: string; data: unknown }> = [];
    const toolStarts = new Map<string, number[]>();
    let lastTurnText = "";

    const unsubscribe = session.subscribe((event) => {
      events.push({ type: event.type, data: event });
      this.recordAgentEventLog(event, {
        flow: "wechat_message",
        memberId: member.id,
        traceId,
        toolStarts,
      });
      if (event.type === "turn_end") {
        if (event.message.content) lastTurnText = event.message.content;
        if (event.usage) {
          this.db.logTokenUsage(member.id, event.usage.promptTokens, event.usage.completionTokens, model);
        }
      }
    });

    try {
      await session.prompt(this.createPromptInput(enhancedMessage, modelMedia));
    } catch (err) {
      // Stop typing on error
      await this.stopTyping(member.id);
      
      const error = err instanceof Error ? err : new Error(String(err));
      this.systemLogger.logError({
        source: "Butler.handleMessage",
        message: "LLM prompt failed",
        input: { memberId: member.id, enhancedMessage },
        details: { model, eventCount: events.length },
        error,
        durationMs: Date.now() - startedAt,
        traceId,
      });
      
      // 使用错误处理器处理 LLM 错误
      try {
        if (member.role === "admin") {
          await this.sendErrorMessage(member, error);
          return;
        }

        const errorResult = await this.errorHandler.handleLLMError(error, msg, {
          memberId: member.id
        });
        
        if (errorResult.shouldFallbackToText && errorResult.modifiedMessage) {
          // 使用纯文本降级重试
          const fallbackBuilt = await this.buildEnhancedMessage(errorResult.modifiedMessage);
          pipelineProcessed = ButlerService.mergeProcessedMediaInfo(
            pipelineProcessed,
            fallbackBuilt.processedMedia,
          );
          enhancedMessage = fallbackBuilt.message;

          try {
            await session.prompt(enhancedMessage);
            console.log(`[Butler] LLM 错误后纯文本降级成功: ${member.id}`);
            this.systemLogger.logRuntime({
              source: "Butler.handleMessage",
              message: "Text fallback prompt succeeded",
              input: { memberId: member.id, enhancedMessage },
              details: { model },
              traceId,
            });
          } catch (fallbackErr) {
            // 纯文本降级也失败，发送友好错误消息
            this.systemLogger.logError({
              source: "Butler.handleMessage",
              message: "Text fallback prompt failed",
              input: { memberId: member.id, enhancedMessage },
              details: { model },
              error: fallbackErr,
              durationMs: Date.now() - startedAt,
              traceId,
            });
            await this.sendErrorMessage(member, fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
            return;
          }
        } else {
          await this.sendErrorMessage(member, error);
          return;
        }
      } catch (handlerErr) {
        // 错误处理器本身出错，发送基础错误消息
        await this.sendErrorMessage(member, error);
        return;
      }
    } finally {
      unsubscribe();
    }

    const reply = lastTurnText || "（无回复）";

    const mediaContent = msg.mediaContent || [];
    const processedMedia = ButlerService.mergeProcessedMediaInfo(
      pipelineProcessed,
      this.extractProcessedMediaInfo(events, mediaContent),
    );
    this.db.saveConversationLogWithMedia(
      member.id,
      member.name,
      msg.text,
      reply,
      JSON.stringify(events),
      mediaContent,
      processedMedia,
    );
    this.db.saveChat(member.id, "user", msg.text);
    this.db.saveChat(member.id, "assistant", reply);

    // 智能上下文长度管理
    try {
      await this.manageContextLength(session, member.id);
    } catch (error) {
      console.error(`[ContextManager] 上下文管理失败，memberId: ${member.id}`, error);
    }

    // Stop typing before sending reply
    await this.stopTyping(member.id);
    await this.gateway.sendToMember(member.id, reply);
    this.systemLogger.logRuntime({
      source: "Butler.handleMessage",
      message: "Inbound member message completed",
      input: {
        memberId: member.id,
        text: msg.text,
        mediaCount: mediaContent.length,
      },
      output: { reply },
      details: { model, eventCount: events.length, processedMediaCount: processedMedia.length },
      durationMs: Date.now() - startedAt,
      traceId,
    });
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
        summary += "\n你可以随时告诉我调整习惯，或在管理页面查看和编辑。";

        // Auto-apply profile and routines
        if (result.profile) {
          this.storage.writeMemberProfile(member.id, result.profile);
        }
        if (result.routines.length > 0) {
          this.applyRoutines(member.id, result.routines);
        }

        await this.gateway.sendToMember(member.id, summary);
      } catch (err) {
        await this.sendErrorMessage(member, err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    // Start typing indicator for interview responses
    await this.startTyping(member.id);

    try {
      const reply = await this.interviewChat(member.id, trimmed);
      await this.stopTyping(member.id);
      await this.gateway.sendToMember(member.id, reply);
    } catch (err) {
      await this.stopTyping(member.id);
      await this.sendErrorMessage(member, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Handle a message from an unbound WeChat connection.
   * Guides the user to the admin binding flow, or binds by exact existing member name.
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
          `请在管理后台解除旧绑定或点击过期连接的「重新扫码」。如需绑定其他未绑定成员，请输入完整成员名。\n\n` +
          `当前家庭成员：\n${membersList}`,
        );
        return;
      }

      // Bind to existing member
      if (ch) {
        ch.bindMember(connectionId, existingMember.id);
        this.familyManager.bindChannel(existingMember.id, "wechat", connectionId);
        this.db.recordWechatInboundActivity(existingMember.id);
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

    await send(
      `这个微信连接还没有绑定家庭成员。\n\n` +
      `请在管理后台的「微信连接」页面完成绑定；如果要直接从微信绑定已有成员，请输入完整成员名。\n\n` +
      `当前家庭成员：\n${membersList}`,
    );
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
          "  /schedule     - 今日安排",
          "  /schedule @名字 - 查看指定成员的今日安排",
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

      case "schedule": {
        const targetName = args.join(" ").replace("@", "").trim();
        let targetMember = member;
        if (targetName) {
          const found = this.familyManager.getMembers().find((m) => m.name === targetName);
          if (!found) return `未找到成员「${targetName}」`;
          targetMember = found;
        }
        const schedule = this.routineEngine.resolveDaySchedule(targetMember.id, new Date());
        if (schedule.items.length === 0) return `${targetMember.name} 今日无安排`;
        return `📅 ${targetMember.name} 今日安排：\n` + schedule.items.map((it) =>
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

  applyRoutines(memberId: string, routines: Routine[]): void {
    for (const routine of routines) {
      this.routineEngine.setRoutine(memberId, routine);
    }
  }

  async shutdown(): Promise<void> {
    this.actionExecutor.stop();
    this.reminderScheduler.shutdown();
    this.activityReminderScheduler.shutdown();
    
    // 停止会话持久化并保存所有会话
    this.stopSessionPersistence();

    // 停止记忆管理
    this.stopMemoryManagement();
    
    await this.gateway.stopAll();
    this.systemLogger.restoreConsole();
    this.db.close();
  }
}
