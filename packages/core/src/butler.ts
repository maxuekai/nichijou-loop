import { createProvider } from "@nichijou/ai";
import type { LLMProvider } from "@nichijou/ai";
import { AgentSession, createAgentSession } from "@nichijou/agent";
import type { AgentEvent } from "@nichijou/agent";
import { getZonedDateTimeParts } from "@nichijou/shared";
import type { FamilyMember, InboundMessage, ToolDefinition, Routine, RoutineAction, Plan } from "@nichijou/shared";
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
import { ReminderScheduler } from "./reminder/reminder-scheduler.js";
import { ActivityReminderScheduler } from "./reminder/activity-reminder.js";
import { PluginHost } from "./plugin-host/plugin-host.js";
import { resolvePluginImportUrl } from "./plugins/resolve-plugin.js";
import { ActionExecutor } from "./routine/action-executor.js";
import { ModelManager } from "./services/model-manager.js";
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
    this.activityReminderScheduler = new ActivityReminderScheduler(this.db, this.gateway, this.familyManager);
    this.pluginHost = new PluginHost(this.storage);
    this.modelManager = new ModelManager(this.config);
    this.actionExecutor = new ActionExecutor(
      this.routineEngine, this.familyManager, this.pluginHost,
      this.gateway, null, this.db, this.config,
    );
    this.actionExecutor.setChatFunction((memberId, prompt) => this.chat(memberId, prompt));

    // 执行配置迁移
    this.modelManager.migrateFromLegacyConfig();

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

  getProvider(context?: AgentContext): LLMProvider {
    // 如果指定了上下文中的模型ID，优先使用
    if (context?.preferredModelId) {
      const model = this.modelManager.getModelById(context.preferredModelId);
      if (model && model.enabled) {
        return createProvider({
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          model: model.model,
          timeout: model.timeout
        });
      }
    }

    // 如果指定了agent上下文，尝试获取agent绑定的模型
    if (context?.agentId) {
      const agentModel = this.modelManager.getModelForAgent(context.agentId);
      if (agentModel && agentModel.enabled) {
        return createProvider({
          baseUrl: agentModel.baseUrl,
          apiKey: agentModel.apiKey,
          model: agentModel.model,
          timeout: agentModel.timeout
        });
      }
    }

    // 使用新的多模型配置
    const activeModel = this.modelManager.getActiveModel();
    if (activeModel && activeModel.enabled) {
      if (!this.provider) {
        this.provider = createProvider({
          baseUrl: activeModel.baseUrl,
          apiKey: activeModel.apiKey,
          model: activeModel.model,
          timeout: activeModel.timeout
        });
        this.actionExecutor.setProvider(this.provider);
      }
      return this.provider;
    }

    // 回退到旧的配置格式（向后兼容）
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

  private currentMemberId: string | undefined;
  
  // 上下文管理配置
  private readonly MAX_CONTEXT_MESSAGES = 100; // 最大消息数
  private readonly KEEP_RECENT_MESSAGES = 30;   // 保留的最近消息数
  
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
      ...this.createDebugTools(), // 添加调试工具
      ...this.pluginHost.getAllTools(),
    ];
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
  private async manageContextLength(session: any, memberId: string): Promise<void> {
    const messages = session.getMessages();
    
    if (messages.length <= this.MAX_CONTEXT_MESSAGES) {
      return; // 未超出限制，无需处理
    }

    // 找到系统消息
    const systemMessage = messages.find((msg: any) => msg.role === "system");
    if (!systemMessage) {
      console.warn(`[ContextManager] 未找到系统消息，memberId: ${memberId}`);
      return;
    }

    // 保留最近的消息（排除系统消息）
    const nonSystemMessages = messages.filter((msg: any) => msg.role !== "system");
    const recentMessages = nonSystemMessages.slice(-this.KEEP_RECENT_MESSAGES);
    const oldMessages = nonSystemMessages.slice(0, -this.KEEP_RECENT_MESSAGES);

    if (oldMessages.length === 0) {
      return; // 没有需要压缩的旧消息
    }

    // 生成对话摘要
    const summary = await this.generateConversationSummary(oldMessages, memberId);
    
    // 创建摘要消息
    const summaryMessage = {
      role: "system" as const,
      content: `# 对话历史摘要\n\n${summary}\n\n---\n\n${systemMessage.content}`,
    };

    // 重构消息数组：摘要 + 最近消息
    const newMessages = [summaryMessage, ...recentMessages];
    
    // 清除旧会话并创建新的
    session.clearHistory();
    session.updateSystemPrompt(summaryMessage.content);
    
    // 重新添加最近的消息到会话中
    for (const msg of recentMessages) {
      if (msg.role !== "system") {
        // 注意：这里简化处理，实际可能需要更复杂的消息恢复逻辑
        session.state.messages.push(msg);
      }
    }

    console.log(`[ContextManager] 压缩了 ${oldMessages.length} 条历史消息，保留了 ${recentMessages.length} 条最近消息，memberId: ${memberId}`);

    // 保存摘要到数据库
    this.saveConversationSummary(memberId, oldMessages, summary);
  }

  /**
   * 生成对话摘要
   */
  private async generateConversationSummary(messages: any[], memberId: string): Promise<string> {
    const member = this.familyManager.getMember(memberId);
    const memberName = member?.preferredName || member?.name || "未知成员";
    
    // 构建摘要提示
    let conversationText = "";
    for (const msg of messages) {
      const speaker = msg.role === "user" ? memberName : "管家";
      conversationText += `${speaker}: ${msg.content}\n`;
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
   * 保存对话摘要到数据库
   */
  private saveConversationSummary(memberId: string, messages: any[], summary: string): void {
    if (messages.length === 0) return;

    const startTime = new Date();
    const endTime = new Date();
    
    try {
      this.db.saveSummary(memberId, summary, startTime.toISOString(), endTime.toISOString());
    } catch (error) {
      console.error(`[ContextManager] 保存对话摘要失败，memberId: ${memberId}`, error);
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
  private restoreSessionFromDatabase(memberId: string): any | null {
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
        .map(chat => ({
          role: chat.role as "user" | "assistant",
          content: chat.content,
        }));

      let finalMessages = sessionData.messages;
      
      if (newMessages.length > 0) {
        console.log(`[SessionPersistence] 发现 ${newMessages.length} 条新的历史消息，整合到会话中，memberId: ${memberId}`);
        finalMessages = [...sessionData.messages, ...newMessages];
      }

      // 创建新的会话并恢复状态
      const member = this.familyManager.getMember(memberId);
      const session = createAgentSession({
        provider: this.getProvider(),
        systemPrompt: this.buildSystemPrompt(member ?? undefined), // 使用最新的系统提示
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
  private restoreSessionFromChatHistory(memberId: string): any | null {
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
      const messages = recentChats.reverse().map(chat => ({
        role: chat.role as "user" | "assistant",
        content: chat.content,
      }));

      // 添加当前系统提示作为第一条消息
      const member = this.familyManager.getMember(memberId);
      const systemPrompt = this.buildSystemPrompt(member ?? undefined);
      const finalMessages = [
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

      // 检查摘要是否过于陈旧（超过30天忽略）
      const summaryDate = new Date(latestSummary.createdAt);
      const now = new Date();
      const daysSinceSummary = (now.getTime() - summaryDate.getTime()) / (1000 * 60 * 60 * 24);
      
      if (daysSinceSummary > 30) {
        console.log(`[MemorySummary] 摘要过于陈旧（${daysSinceSummary.toFixed(1)}天），忽略，memberId: ${memberId}`);
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

2. **重要决定与计划**：
   - 近期的重要决定
   - 制定的计划和目标
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
    try {
      console.log('[MemoryManager] 开始执行记忆清理任务');

      // 清理30天前的聊天记录
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

      console.log('[MemoryManager] 记忆清理任务完成');
    } catch (error) {
      console.error('[MemoryManager] 记忆清理任务失败', error);
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
      const plan = this.routineEngine.resolveDayPlan(member.id, today, tz);
      if (plan.items.length > 0) {
        prompt += `# 今日计划\n\n`;
        for (const item of plan.items) {
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

  getOrCreateSession(memberId: string, isOnboarding = false): AgentSession {
    if (!isOnboarding) {
      const existing = this.sessions.get(memberId);
      if (existing) return existing;

      // 尝试从数据库恢复会话
      const restored = this.restoreSessionFromDatabase(memberId);
      if (restored) {
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
  async chat(memberId: string, input: string, onEvent?: (event: AgentEvent) => void): Promise<string> {
    // 设置当前成员ID供工具使用
    this.currentMemberId = memberId;

    const session = this.getOrCreateSession(memberId);
    const member = this.familyManager.getMember(memberId);
    
    // 强制更新系统提示以确保时间信息是最新的
    session.updateSystemPrompt(this.buildSystemPrompt(member ?? undefined));
    
    // 在用户输入前注入当前时间提醒，确保AI知道准确的时间
    const { display, iso } = this.formatNow();
    const timeAwareInput = `[系统时间更新: ${display}, ISO: ${iso}]\n\n${input}`;
    
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
      const response = await session.prompt(timeAwareInput);
      this.db.saveChat(memberId, "user", input);
      this.db.saveChat(memberId, "assistant", response);
      
      // 智能上下文长度管理
      try {
        await this.manageContextLength(session, memberId);
      } catch (error) {
        console.error(`[ContextManager] 上下文管理失败，memberId: ${memberId}`, error);
      }
      
      return response;
    } finally {
      unsub();
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
   * Handle an inbound WeChat/channel message.
   * If the member has an active interview, route to the interview flow.
   * Otherwise, normal agent session.
   */
  private async handleMessage(member: FamilyMember, msg: InboundMessage): Promise<void> {
    // 设置当前成员ID供工具使用
    this.currentMemberId = member.id;
    
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

    // Start typing indicator
    await this.startTyping(member.id);

    const session = this.getOrCreateSession(member.id);
    
    // 统一系统提示刷新机制：每轮对话前更新系统提示
    // 确保与Web路径（chat方法）行为一致
    session.updateSystemPrompt(this.buildSystemPrompt(member));

    // 在用户输入前注入当前时间提醒，确保AI知道准确的时间
    const { display, iso } = this.formatNow();
    const timeAwareMessage = `[系统时间更新: ${display}, ISO: ${iso}]\n\n${msg.text}`;

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
      await session.prompt(timeAwareMessage);
    } catch (err) {
      // Stop typing on error
      await this.stopTyping(member.id);
      
      // 记录错误但不让整个服务崩溃
      console.error(`Agent session error for member ${member.id}:`, err);
      
      // 给用户一个友好的错误消息
      const errorMessage = err instanceof Error ? err.message : String(err);
      let userFriendlyMessage = "抱歉，处理您的消息时出现了问题。";
      
      // 针对特定错误类型提供更有用的信息
      if (errorMessage.includes('LLM_ERROR')) {
        userFriendlyMessage += "大模型服务暂时不可用，请稍后重试。";
      } else if (errorMessage.includes('AbortError') || errorMessage.includes('timeout')) {
        userFriendlyMessage += "请求超时，请稍后重试。";
      } else if (errorMessage.includes('tool_calls')) {
        userFriendlyMessage += "工具调用出现问题，但您可以继续其他对话。";
      } else {
        userFriendlyMessage += "请稍后重试或联系管理员。";
      }
      
      try {
        await this.gateway.sendToMember(member.id, userFriendlyMessage);
      } catch (sendErr) {
        console.error(`Failed to send error message to member ${member.id}:`, sendErr);
      }
      
      // 不再重新抛出错误，让服务继续运行
      return;
    } finally {
      unsubscribe();
    }

    const reply = lastTurnText || "（无回复）";

    this.db.saveConversationLog(member.id, msg.text, reply, JSON.stringify(events));
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

    // Start typing indicator for interview responses
    await this.startTyping(member.id);

    try {
      const reply = await this.interviewChat(member.id, trimmed);
      await this.stopTyping(member.id);
      await this.gateway.sendToMember(member.id, reply);
    } catch (err) {
      await this.stopTyping(member.id);
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

  async parseRoutineDescription(memberId: string, description: string): Promise<{ routine: Routine; warnings: string[] }> {
    // 使用新的工具感知解析方法
    return this.parseRoutineDescriptionWithTools(memberId, description);
  }


  /**
   * 创建习惯解析专用的工具集
   */
  private createHabitParsingTools(): ToolDefinition[] {
    const pluginTools = this.pluginHost.getAllTools();
    
    return [
      // 工具验证和探索工具
      {
        name: "validate_plugin_tool",
        description: "验证指定插件工具的参数要求和可用性，在生成habit动作前使用此工具确保参数正确",
        parameters: {
          type: "object",
          properties: {
            toolName: { type: "string", description: "要验证的工具名称" },
            proposedParams: { 
              type: "object", 
              description: "拟议的工具参数",
              additionalProperties: true
            },
          },
          required: ["toolName"],
        },
        execute: async (params) => {
          const toolName = params.toolName as string;
          const proposedParams = params.proposedParams as Record<string, unknown> || {};
          
          // 查找工具
          const tool = pluginTools.find(t => t.name === toolName);
          if (!tool) {
            return { 
              content: `工具 "${toolName}" 不存在。可用的插件工具：${pluginTools.map(t => t.name).join(', ')}`,
              isError: true 
            };
          }

          // 验证必需参数
          const schema = tool.parameters;
          if (schema?.required && Array.isArray(schema.required)) {
            const missingParams = schema.required.filter((param: string) => 
              !(param in proposedParams)
            );
            if (missingParams.length > 0) {
              return {
                content: `工具 "${toolName}" 缺少必需参数: ${missingParams.join(', ')}。参数schema: ${JSON.stringify(schema.properties || {}, null, 2)}`,
                isError: false, // 不是错误，是验证结果
              };
            }
          }

          return {
            content: `工具 "${toolName}" 参数验证成功。描述: ${tool.description}`,
            isError: false,
          };
        },
      },
      
      // 时间解析和验证工具
      {
        name: "parse_time_expression",
        description: "解析用户的时间表达式为具体的时间和星期设置",
        parameters: {
          type: "object",
          properties: {
            timeExpression: { type: "string", description: "用户的时间描述，如'每天早上8点'、'周一到周五晚上9点'" },
          },
          required: ["timeExpression"],
        },
        execute: async (params) => {
          const expression = (params.timeExpression as string).toLowerCase();
          const result: {
            weekdays?: number[];
            time?: string;
            timeSlot?: "morning" | "afternoon" | "evening";
            confidence: number;
            warnings: string[];
          } = {
            confidence: 0.8,
            warnings: [],
          };

          // 解析星期
          if (expression.includes('每天') || expression.includes('每日')) {
            result.weekdays = [0, 1, 2, 3, 4, 5, 6];
          } else if (expression.includes('工作日') || expression.includes('周一到周五')) {
            result.weekdays = [1, 2, 3, 4, 5];
          } else if (expression.includes('周末')) {
            result.weekdays = [0, 6];
          } else {
            // 解析具体星期
            const weekdayMap: Record<string, number> = {
              '周日': 0, '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6,
              '星期日': 0, '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4, '星期五': 5, '星期六': 6,
            };
            
            const foundWeekdays: number[] = [];
            for (const [key, value] of Object.entries(weekdayMap)) {
              if (expression.includes(key)) {
                foundWeekdays.push(value);
              }
            }
            
            if (foundWeekdays.length > 0) {
              result.weekdays = foundWeekdays.sort((a, b) => a - b);
            } else {
              result.weekdays = [0, 1, 2, 3, 4, 5, 6]; // 默认每天
              result.warnings.push("未能识别具体星期，默认设为每天");
              result.confidence = 0.5;
            }
          }

          // 解析具体时间
          const timeMatch = expression.match(/(\d{1,2})[:\：](\d{2})/);
          if (timeMatch) {
            const hour = parseInt(timeMatch[1]);
            const minute = parseInt(timeMatch[2]);
            if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
              result.time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            }
          } else {
            // 解析模糊时间
            if (expression.includes('早上') || expression.includes('上午')) {
              result.timeSlot = "morning";
              if (!result.time) result.time = "08:00";
            } else if (expression.includes('下午')) {
              result.timeSlot = "afternoon";  
              if (!result.time) result.time = "14:00";
            } else if (expression.includes('晚上') || expression.includes('夜里')) {
              result.timeSlot = "evening";
              if (!result.time) result.time = "20:00";
            }
            
            if (!result.time) {
              result.time = "09:00";
              result.warnings.push("未能识别具体时间，默认设为9:00");
              result.confidence = Math.min(result.confidence, 0.6);
            }
          }

          return {
            content: JSON.stringify(result, null, 2),
            isError: false,
          };
        },
      },

      // 动作类型推荐工具
      {
        name: "recommend_action_types", 
        description: "根据用户的习惯描述推荐合适的动作类型组合",
        parameters: {
          type: "object",
          properties: {
            description: { type: "string", description: "用户的习惯描述" },
            availableTools: { 
              type: "array", 
              items: { type: "string" },
              description: "可用的插件工具名称列表"
            },
          },
          required: ["description"],
        },
        execute: async (params) => {
          const description = (params.description as string).toLowerCase();
          const availableTools = params.availableTools as string[] || [];
          
          const recommendations: {
            actionType: "notify" | "ai_task" | "plugin";
            reason: string;
            trigger: "before" | "at" | "after";
            priority: number;
            params?: Record<string, unknown>;
            confidence?: number;
          }[] = [];

          // 1. 智能数据获取需求分析
          const dataCategories = {
            weather: { 
              keywords: ['天气', '气温', '下雨', '晴天', '阴天', '温度', '风', '湿度', '穿衣'],
              confidence: 0.9,
              prompt: "查询天气信息并提供穿衣建议"
            },
            news: { 
              keywords: ['新闻', '资讯', '热点', '头条', '事件'],
              confidence: 0.8,
              prompt: "获取最新新闻资讯摘要"
            },
            financial: { 
              keywords: ['股价', '汇率', '股票', '基金', '金融'],
              confidence: 0.85,
              prompt: "查询金融市场数据"
            },
            traffic: { 
              keywords: ['路况', '交通', '堵车', '地铁'],
              confidence: 0.8,
              prompt: "查询交通路况信息"
            },
            health: { 
              keywords: ['血压', '心率', '体重', '健康', '睡眠'],
              confidence: 0.75,
              prompt: "获取健康监测数据"
            },
            schedule: { 
              keywords: ['日程', '会议', '安排', '计划表', '约会'],
              confidence: 0.8,
              prompt: "检查今日日程安排"
            }
          };

          let bestDataMatch: { category: string; confidence: number; prompt: string } | null = null;
          
          for (const [category, config] of Object.entries(dataCategories)) {
            const matchCount = config.keywords.filter(kw => description.includes(kw)).length;
            if (matchCount > 0) {
              const matchConfidence = Math.min(matchCount * 0.3 + 0.4, config.confidence);
              if (!bestDataMatch || matchConfidence > bestDataMatch.confidence) {
                bestDataMatch = { category, confidence: matchConfidence, prompt: config.prompt };
              }
            }
          }

          if (bestDataMatch) {
            recommendations.push({
              actionType: "ai_task",
              reason: `检测到${bestDataMatch.category}数据需求`,
              trigger: "at",
              priority: 1,
              confidence: bestDataMatch.confidence,
              params: { prompt: bestDataMatch.prompt }
            });
          }

          // 2. 智能通知类型分析
          const notificationTypes = {
            remind: { keywords: ['提醒', '提示', '叫醒', '催促'], urgency: 'normal' },
            inform: { keywords: ['告诉', '通知', '报告', '汇报'], urgency: 'low' },
            alert: { keywords: ['警告', '注意', '小心', '当心'], urgency: 'high' },
            broadcast: { keywords: ['播报', '发送', '推送', '发布'], urgency: 'medium' }
          };

          let bestNotifyType: { type: string; urgency: string; confidence: number } | null = null;
          
          for (const [type, config] of Object.entries(notificationTypes)) {
            const matches = config.keywords.filter(kw => description.includes(kw)).length;
            if (matches > 0) {
              const confidence = Math.min(matches * 0.4 + 0.3, 0.9);
              if (!bestNotifyType || confidence > bestNotifyType.confidence) {
                bestNotifyType = { type, urgency: config.urgency, confidence };
              }
            }
          }

          // 3. 时机智能分析
          const timingPatterns = {
            before: { keywords: ['提前', '之前', '先', '预先'], offset: -5 },
            at: { keywords: ['到时', '准时', '当时', '立即'], offset: 0 },
            after: { keywords: ['之后', '后来', '完成后', '结束后'], offset: 5 }
          };

          let bestTiming: { trigger: "before" | "at" | "after"; offset: number } = { trigger: "at", offset: 0 };
          for (const [timing, config] of Object.entries(timingPatterns)) {
            if (config.keywords.some(kw => description.includes(kw))) {
              bestTiming = { trigger: timing as "before" | "at" | "after", offset: config.offset };
              break;
            }
          }

          // 4. 添加通知推荐
          if (bestNotifyType || bestDataMatch) {
            let message = "习惯提醒";
            let trigger = bestTiming.trigger;

            if (bestDataMatch) {
              message = "{{result}}";
              trigger = "after"; // 数据任务后发送结果
            } else if (bestNotifyType?.urgency === 'high') {
              message = `⚠️ 注意：${description.slice(0, 30)}`;
            } else if (bestNotifyType?.urgency === 'low') {
              message = description.slice(0, 50);
            }

            recommendations.push({
              actionType: "notify",
              reason: bestDataMatch 
                ? "发送数据查询结果" 
                : `执行${bestNotifyType?.type || 'basic'}通知`,
              trigger,
              priority: bestDataMatch ? 2 : 1,
              confidence: bestNotifyType?.confidence || 0.7,
              params: { message }
            });
          }

          // 5. 智能插件匹配
          if (availableTools.length > 0) {
            // 扩展关键词词典，支持更多变体和场景
            const toolPatterns: Record<string, string[]> = {
              weather: ['天气', '气温', '温度', '降雨', '下雨', '晴天', '阴天', '多云', '刮风', '湿度', '穿衣', 'weather'],
              news: ['新闻', '资讯', '热点', '头条', '事件', '周刊', '周报', '日报', '播报', '汇总', '摘要', 'news'],
              fitness: ['健身', '运动', '锻炼', '训练', '跑步', '游泳', '瑜伽', 'fitness', 'workout'],
              calendar: ['日程', '会议', '安排', '计划', '约会', '预约', 'calendar', 'schedule'],
              finance: ['股价', '金融', '投资', '基金', '股票', 'stock', 'finance']
            };

            for (const tool of availableTools) {
              let matchScore = 0;
              const toolLower = tool.toLowerCase();
              
              // 直接匹配（工具名包含在描述中）
              if (description.includes(toolLower)) {
                matchScore += 0.8;
              }

              // 模式匹配（基于工具类型和关键词）
              for (const [pattern, keywords] of Object.entries(toolPatterns)) {
                if (toolLower.includes(pattern)) {
                  const keywordMatches = keywords.filter(kw => description.includes(kw)).length;
                  matchScore += keywordMatches * 0.25;
                }
              }
              
              // 场景化匹配（特殊组合加分）
              const scenarioBoost = this.calculateScenarioBoost(tool, description);
              matchScore += scenarioBoost;

              // 降低匹配阈值以提高覆盖率
              if (matchScore >= 0.3) {
                recommendations.push({
                  actionType: "plugin",
                  reason: `智能匹配插件: ${tool} (匹配度: ${(matchScore * 100).toFixed(0)}%)`,
                  trigger: bestTiming.trigger,
                  priority: Math.ceil(3 - matchScore * 2), // 匹配度越高优先级越高
                  confidence: Math.min(matchScore, 0.95),
                  params: { toolName: tool }
                });
              }
            }
          }

          // 6. 复杂逻辑检测
          const complexityMarkers = {
            conditional: ['如果', '当', '假如', '要是'],
            sequential: ['然后', '接着', '之后', '先'],
            parallel: ['同时', '并且', '一边'],
            choice: ['或者', '或是', '要么']
          };

          let complexityType: string | null = null;
          for (const [type, markers] of Object.entries(complexityMarkers)) {
            if (markers.some(marker => description.includes(marker))) {
              complexityType = type;
              break;
            }
          }

          if (complexityType && !recommendations.some(r => r.actionType === 'ai_task')) {
            recommendations.push({
              actionType: "ai_task",
              reason: `检测到${complexityType}逻辑，使用AI智能处理`,
              trigger: "at",
              priority: 1,
              confidence: 0.75,
              params: { prompt: `智能处理复杂习惯逻辑：${description}` }
            });
          }

          // 7. 兜底策略
          if (recommendations.length === 0) {
            recommendations.push({
              actionType: "notify",
              reason: "默认习惯提醒（未识别特定需求）",
              trigger: "at",
              priority: 1,
              confidence: 0.5,
              params: { message: "习惯提醒" }
            });
          }

          // 8. 质量评估和排序
          const finalRecommendations = recommendations
            .sort((a, b) => {
              const priorityDiff = a.priority - b.priority;
              if (priorityDiff !== 0) return priorityDiff;
              return (b.confidence || 0.6) - (a.confidence || 0.6);
            })
            .slice(0, 3); // 限制推荐数量

          const avgConfidence = finalRecommendations.length > 0
            ? finalRecommendations.reduce((sum, r) => sum + (r.confidence || 0.6), 0) / finalRecommendations.length
            : 0.5;

          return {
            content: JSON.stringify({
              recommendations: finalRecommendations,
              confidence: avgConfidence,
              complexity: complexityType ? 'high' : bestDataMatch ? 'medium' : 'simple',
              analysis: {
                dataTaskDetected: !!bestDataMatch,
                dataCategory: bestDataMatch?.category,
                notificationType: bestNotifyType?.type,
                timingPreference: bestTiming.trigger,
                complexityType,
                toolsEvaluated: availableTools.length,
                matchedTools: finalRecommendations.filter(r => r.actionType === 'plugin').length
              }
            }, null, 2),
            isError: false,
          };
        },
      },

      // 生成最终习惯结构工具
      {
        name: "generate_routine_structure",
        description: "基于分析结果生成最终的习惯结构",
        parameters: {
          type: "object", 
          properties: {
            title: { type: "string", description: "习惯标题" },
            timeInfo: { 
              type: "object",
              description: "时间信息（来自parse_time_expression的结果）",
              additionalProperties: true
            },
            actionRecommendations: {
              type: "array",
              description: "动作推荐（来自recommend_action_types的结果）",
              items: { type: "object", additionalProperties: true }
            },
            originalDescription: { type: "string", description: "用户原始描述" },
          },
          required: ["title", "timeInfo", "actionRecommendations", "originalDescription"],
        },
        execute: async (params) => {
          const title = params.title as string;
          const timeInfo = params.timeInfo as any;
          const actionRecommendations = params.actionRecommendations as any[];
          const originalDescription = params.originalDescription as string;

          // 构建actions数组
          const actions: any[] = [];
          
          for (const rec of actionRecommendations) {
            const actionId = `act_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;
            
            const baseAction = {
              id: actionId,
              type: rec.actionType,
              trigger: rec.trigger,
              offsetMinutes: 0,
              channel: "wechat",
            };

            switch (rec.actionType) {
              case "notify":
                actions.push({
                  ...baseAction,
                  message: rec.params?.message || title,
                });
                break;
                
              case "ai_task":
                actions.push({
                  ...baseAction,
                  prompt: rec.params?.prompt || `执行习惯任务：${originalDescription}`,
                });
                break;
                
              case "plugin":
                const toolName = rec.params?.toolName;
                const baseParams = rec.params?.toolParams || {};
                
                // 应用智能参数推理
                const inferredParams = this.inferToolParameters(toolName, originalDescription, baseParams);
                
                actions.push({
                  ...baseAction,
                  toolName,
                  toolParams: inferredParams,
                });
                break;
            }
          }

          const routine = {
            id: `rtn_${Date.now().toString(36)}`,
            title,
            description: originalDescription,
            weekdays: timeInfo.weekdays || [0, 1, 2, 3, 4, 5, 6],
            time: timeInfo.time,
            timeSlot: timeInfo.timeSlot,
            reminders: [],
            actions,
            confidence: Math.min(timeInfo.confidence || 0.8, 0.9),
            toolValidations: [] as any[], // 将在工具验证后填充
          };

          return {
            content: JSON.stringify(routine, null, 2),
            isError: false,
          };
        },
      },
    ];
  }

  /**
   * 工具感知的习惯解析方法，支持真正的工具调用和参数验证
   */
  async parseRoutineDescriptionWithTools(memberId: string, description: string): Promise<{ routine: Routine; warnings: string[] }> {
    const member = this.familyManager.getMember(memberId);
    const existing = this.routineEngine.getRoutines(memberId);
    const { display, iso } = this.formatNow();
    const warnings: string[] = [];

    const pluginTools = this.pluginHost.getAvailableTools();
    const availableToolNames = pluginTools.map(t => t.toolName);
    
    // 构建解析专用的系统提示
    const parseSystemPrompt = [
      "你是家庭AI管家的高级习惯解析助手。你需要分析用户的习惯描述，并使用提供的工具来生成准确的习惯配置。",
      "",
      `当前时间: ${display} (${iso})`,
      member ? `当前成员: ${member.name}` : "",
      "",
      "# 解析流程",
      "1. 使用 parse_time_expression 工具分析时间表达式",
      "2. 使用 recommend_action_types 工具获取动作类型推荐",
      "3. 如果推荐包含 plugin 类型，使用 validate_plugin_tool 验证工具参数",
      "4. 使用 generate_routine_structure 工具生成最终结构",
      "",
      "# 可用的插件工具",
      pluginTools.length > 0 
        ? pluginTools.map((t) => `  - ${t.toolName}（${t.pluginName}）: ${t.description}`).join("\n")
        : "  （暂无已安装插件）",
      "",
      existing.length > 0 ? `# 已有习惯（避免重复）\n${existing.map((r) => `- ${r.title} (${r.weekdays.map((d) => ["日","一","二","三","四","五","六"][d]).join("、")}${r.time ? " " + r.time : ""})`).join("\n")}` : "",
      "",
      "# 解析要求",
      "- 必须按顺序使用工具进行分析",
      "- 优先使用 ai_task 而非直接的 plugin 调用（除非用户明确要求特定插件）",
      "- 仔细验证工具参数的正确性",
      "- 如果某个功能需要插件但插件未安装，记录到warnings中",
      "- 最终调用 generate_routine_structure 工具输出结果",
    ].filter(Boolean).join("\n");

    // 创建解析专用的Agent Session
    const parseSession = createAgentSession({
      provider: this.getProvider(),
      systemPrompt: parseSystemPrompt,
      tools: this.createHabitParsingTools(),
      maxTurns: 15, // 允许多轮工具调用
    });

    let finalResult: any = null;
    let confidence = 0.8;
    const toolValidations: string[] = [];

    try {
      // 开始解析对话
      await parseSession.prompt(`请解析这个习惯描述：${description}`);
      
      // 获取所有消息以进行多源提取
      const messages = parseSession.getMessages();
      
      // 方法1: 优先从generate_routine_structure工具的返回值中提取完整结构
      finalResult = this.extractFromToolResults(messages, toolValidations);
      
      // 方法2: 如果工具结果无效，从最后的assistant消息中提取
      if (!finalResult) {
        finalResult = this.extractFromAssistantMessage(messages);
      }

      // 方法3: 如果以上都失败，启动多层降级机制
      if (!finalResult) {
        console.warn("[HabitParsing] Agent解析失败，启动多层降级机制");
        return this.parseRoutineDescriptionWithMultiLayerFallback(memberId, description, "agent_failed");
      }

    } catch (error) {
      console.error("[HabitParsing] Agent解析过程出错", error);
      warnings.push("AI解析过程出现错误，启动降级模式");
      return this.parseRoutineDescriptionWithMultiLayerFallback(memberId, description, "agent_error");
    }

    // 处理解析结果
    const routine: Routine = {
      id: finalResult.id || `rtn_${Date.now().toString(36)}`,
      title: finalResult.title || description.slice(0, 50),
      description,
      weekdays: finalResult.weekdays || [0, 1, 2, 3, 4, 5, 6],
      time: finalResult.time,
      timeSlot: finalResult.timeSlot,
      reminders: [],
      actions: finalResult.actions || [],
    };

    // 计算综合置信度
    const parseConfidence = this.calculateParsingConfidence(routine, description, toolValidations);
    
    // 收集置信度相关的警告
    if (parseConfidence < 0.5) {
      warnings.push("AI解析置信度很低，强烈建议手动检查和调整所有设置");
    } else if (parseConfidence < 0.7) {
      warnings.push("AI解析置信度较低，建议仔细检查生成的习惯设置");
    }

    // 收集来自解析结果的警告
    if (finalResult.confidence && finalResult.confidence < 0.7) {
      warnings.push("工具解析过程中检测到不确定因素");
    }

    // 收集工具验证警告
    if (finalResult.warnings && Array.isArray(finalResult.warnings)) {
      warnings.push(...finalResult.warnings);
    }

    // 记录解析统计信息用于持续优化
    this.logParsingAnalytics(memberId, description, routine, parseConfidence, warnings.length > 0);

    // 将置信度信息添加到返回结果中
    (routine as any).confidence = parseConfidence;

    // 验证至少有一个动作
    if (!routine.actions || routine.actions.length === 0) {
      // 对于空习惯，智能判断是否需要通知
      const shouldAddNotify = this.shouldRequireNotifyAction([], description);
      
      if (shouldAddNotify) {
        routine.actions = [{
          id: `act_${Date.now().toString(36)}_default`,
          type: "notify",
          trigger: "at",
          offsetMinutes: 0,
          channel: "wechat",
          message: routine.title,
        }];
        warnings.push("未生成具体动作，已添加默认通知");
      } else {
        // 允许创建无动作的习惯（如用于占位或静默任务）
        routine.actions = [];
        warnings.push("此习惯无具体动作，将以静默方式执行");
      }
    } else {
      // 对于有动作的习惯，检查是否需要添加notify
      const hasNotify = routine.actions.some(action => action.type === "notify");
      if (!hasNotify) {
        const shouldAddNotify = this.shouldRequireNotifyAction(routine.actions, description);
        
        if (shouldAddNotify) {
          routine.actions.unshift({
            id: `act_${Date.now().toString(36)}_notify`,
            type: "notify",
            trigger: "after",
            offsetMinutes: 0,
            channel: "wechat",
            message: "{{result}}",
          });
          warnings.push("已自动添加结果通知，如不需要可手动移除");
        } else {
          warnings.push("此习惯设计为静默执行，不会发送通知");
        }
      }
    }

    return { routine, warnings };
  }

  /**
   * 从工具调用结果中提取JSON结构（优先级最高）
   */
  private extractFromToolResults(messages: any[], toolValidations: string[]): any {
    try {
      // 查找所有工具调用及其结果
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        
        // 检查是否是assistant消息且包含工具调用
        if (message.role === "assistant" && message.toolCalls) {
          for (const toolCall of message.toolCalls) {
            toolValidations.push(`调用了工具: ${toolCall.function.name}`);
            
            // 查找对应的工具结果
            const toolResultMessage = messages[i + 1];
            if (toolResultMessage && 
                toolResultMessage.role === "tool" && 
                toolCall.function.name === "generate_routine_structure") {
              
              // 从工具结果中提取JSON
              try {
                const toolResult = JSON.parse(toolResultMessage.content);
                console.log("[HabitParsing] 成功从generate_routine_structure工具结果中提取JSON");
                return toolResult;
              } catch (parseError) {
                console.warn("[HabitParsing] 工具结果JSON解析失败", parseError);
              }
            }
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error("[HabitParsing] 从工具结果提取JSON时出错", error);
      return null;
    }
  }

  /**
   * 从最后的assistant消息中提取JSON结构（次优先级）
   */
  private extractFromAssistantMessage(messages: any[]): any {
    try {
      const lastAssistantMessage = messages
        .filter((msg: any) => msg.role === "assistant")
        .pop();

      if (lastAssistantMessage?.content) {
        const jsonMatch = lastAssistantMessage.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          console.log("[HabitParsing] 成功从assistant消息中提取JSON");
          return result;
        }
      }
      
      return null;
    } catch (parseError) {
      console.warn("[HabitParsing] 从assistant消息提取JSON失败", parseError);
      return null;
    }
  }

  /**
   * 智能参数推理框架：根据工具名称和用户描述推理最佳参数
   */
  private inferToolParameters(toolName: string | undefined, description: string, baseParams: Record<string, any>): Record<string, any> {
    if (!toolName) return baseParams;
    
    const inferredParams = { ...baseParams };
    const descLower = description.toLowerCase();
    
    try {
      // 新闻工具参数推理
      if (toolName === "news_fetch") {
        // 模式推理
        if (!inferredParams.mode) {
          if (descLower.includes("周刊") || descLower.includes("周报") || descLower.includes("一周")) {
            inferredParams.mode = "weekly";
          } else if (descLower.includes("今日") || descLower.includes("今天")) {
            inferredParams.mode = "daily";
            inferredParams.date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
          } else {
            inferredParams.mode = "latest";
          }
        }
        
        // 数量推理
        if (!inferredParams.limit) {
          if (descLower.includes("简要") || descLower.includes("摘要")) {
            inferredParams.limit = 5;
          } else if (descLower.includes("详细") || descLower.includes("完整")) {
            inferredParams.limit = 15;
          } else {
            inferredParams.limit = 10;
          }
        }
        
        // 类别推理
        if (!inferredParams.category) {
          if (descLower.includes("科技") || descLower.includes("技术")) {
            inferredParams.category = "tech";
          } else if (descLower.includes("娱乐") || descLower.includes("影视")) {
            inferredParams.category = "entertainment";
          } else {
            inferredParams.category = "all";
          }
        }
      }
      
      // 天气工具参数推理
      else if (toolName === "weather_query") {
        // 自动注入家庭位置（如果没有指定city参数）
        if (!inferredParams.city) {
          const family = this.familyManager.getFamily();
          if (family?.homeCity) {
            inferredParams.city = family.homeCity;
          } else if (family?.homeAdcode) {
            // 如果有adcode，也可以使用
            inferredParams.adcode = family.homeAdcode;
          }
        }
        
        // 天数推理
        if (!inferredParams.days) {
          if (descLower.includes("明天") || descLower.includes("明日")) {
            inferredParams.days = 2; // 今天+明天
          } else if (descLower.includes("三天") || descLower.includes("3天")) {
            inferredParams.days = 3;
          } else if (descLower.includes("一周") || descLower.includes("7天")) {
            inferredParams.days = 7;
          } else {
            inferredParams.days = 1; // 默认今天
          }
        }
      }
      
      console.log(`[ParamInference] 工具 ${toolName} 参数推理结果:`, {
        original: baseParams,
        inferred: inferredParams,
        description: description.slice(0, 50) + "..."
      });
      
    } catch (error) {
      console.error(`[ParamInference] 工具 ${toolName} 参数推理出错:`, error);
      return baseParams; // 出错时返回原始参数
    }
    
    return inferredParams;
  }

  /**
   * 注册新的参数推理规则（扩展点）
   */
  private registerParameterInferenceRule(toolName: string, rule: (description: string, params: Record<string, any>) => Record<string, any>): void {
    // 预留扩展点，未来可以通过插件系统注册自定义推理规则
    console.log(`[ParamInference] 注册参数推理规则: ${toolName}`);
  }

  /**
   * 计算场景化匹配加分，处理特殊词汇组合
   */
  private calculateScenarioBoost(tool: string, description: string): number {
    let boost = 0;
    const toolLower = tool.toLowerCase();
    const descLower = description.toLowerCase();
    
    // 新闻工具特殊场景
    if (toolLower.includes('news')) {
      // 时间维度加分
      if (descLower.includes('周刊') || (descLower.includes('每周') && descLower.includes('新闻'))) {
        boost += 0.3; // 强烈匹配"新闻周刊"
      }
      if (descLower.includes('播报') && descLower.includes('新闻')) {
        boost += 0.25; // 匹配"播报新闻"
      }
      if (descLower.includes('汇总') || descLower.includes('摘要')) {
        boost += 0.2; // 匹配"新闻汇总"
      }
    }
    
    // 天气工具特殊场景
    else if (toolLower.includes('weather')) {
      if (descLower.includes('播报') && descLower.includes('天气')) {
        boost += 0.25; // 匹配"播报天气"
      }
      if (descLower.includes('明天') || descLower.includes('今天')) {
        boost += 0.2; // 时间明确的天气查询
      }
      if (descLower.includes('出门') || descLower.includes('穿衣')) {
        boost += 0.15; // 生活场景相关
      }
    }
    
    // 多工具组合场景
    if (descLower.includes('天气') && descLower.includes('新闻')) {
      boost += 0.1; // 复合需求轻微加分
    }
    
    return Math.min(boost, 0.4); // 限制最大加分值
  }

  /**
   * 计算AI解析结果的综合置信度评分
   */
  private calculateParsingConfidence(routine: Routine, description: string, toolValidations: string[]): number {
    let confidenceScore = 0.8; // 基础置信度
    const issues: string[] = [];

    // 1. 检查基本字段完整性
    if (!routine.title || routine.title.length < 2) {
      confidenceScore -= 0.2;
      issues.push("标题不完整或过短");
    }

    if (!routine.weekdays || routine.weekdays.length === 0) {
      confidenceScore -= 0.15;
      issues.push("未识别出重复周期");
    }

    // 2. 检查时间解析质量
    const timeKeywords = ['点', '时', '分钟', '上午', '下午', '晚上', '早上', 'am', 'pm'];
    const hasTimeWords = timeKeywords.some(keyword => description.toLowerCase().includes(keyword));
    
    if (hasTimeWords && !routine.time && !routine.timeSlot) {
      confidenceScore -= 0.1;
      issues.push("描述中提到时间但未能解析");
    }

    if (routine.time) {
      // 检查时间格式的合理性
      const [hours, minutes] = routine.time.split(':').map(Number);
      if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        confidenceScore -= 0.15;
        issues.push("时间格式不正确");
      }
    }

    // 3. 检查动作链的逻辑性
    const actions = routine.actions || [];
    if (actions.length === 0) {
      confidenceScore -= 0.1;
      issues.push("未生成任何执行动作");
    } else {
      // 检查动作类型的合理性
      const aiTasks = actions.filter(a => a.type === 'ai_task');
      const notifications = actions.filter(a => a.type === 'notify');
      
      // 如果有AI任务但没有通知，可能不合理（除非是静默任务）
      if (aiTasks.length > 0 && notifications.length === 0) {
        const silentKeywords = ['自动', '静默', '后台', '同步'];
        const isSilentTask = silentKeywords.some(kw => description.includes(kw));
        if (!isSilentTask) {
          confidenceScore -= 0.05;
          issues.push("有AI任务但缺少用户通知");
        }
      }

      // 检查prompt质量
      for (const action of aiTasks) {
        if (!action.prompt || action.prompt.length < 5) {
          confidenceScore -= 0.08;
          issues.push("AI任务描述过于简单");
        }
      }

      // 检查通知消息质量
      for (const notification of notifications) {
        if (notification.message && notification.message !== "{{result}}" && notification.message.length < 2) {
          confidenceScore -= 0.05;
          issues.push("通知消息内容过于简单");
        }
      }
    }

    // 4. 检查描述与解析结果的匹配度
    const descWords = description.toLowerCase();
    const titleWords = routine.title.toLowerCase();
    
    // 简单的关键词匹配检查
    const commonWords = ['的', '了', '在', '和', '或', '与', '及', '、'];
    const descKeywords = descWords.split(/[\s\p{P}]+/u).filter(w => w.length > 1 && !commonWords.includes(w));
    const titleKeywords = titleWords.split(/[\s\p{P}]+/u).filter(w => w.length > 1 && !commonWords.includes(w));
    
    let matchedKeywords = 0;
    for (const keyword of descKeywords.slice(0, 5)) { // 只检查前5个关键词
      if (titleKeywords.some(tw => tw.includes(keyword) || keyword.includes(tw))) {
        matchedKeywords++;
      }
    }
    
    const keywordMatchRate = descKeywords.length > 0 ? matchedKeywords / Math.min(descKeywords.length, 5) : 1;
    if (keywordMatchRate < 0.3) {
      confidenceScore -= 0.1;
      issues.push("标题与描述关键词匹配度低");
    }

    // 5. 工具验证结果的影响
    if (toolValidations.length === 0 && actions.some(a => a.type === 'plugin' || a.type === 'ai_task')) {
      confidenceScore -= 0.05;
      issues.push("未进行工具可用性验证");
    }

    // 6. 复杂度调整
    const complexityWords = ['如果', '当', '然后', '并且', '或者', '除非', '同时'];
    const hasComplexLogic = complexityWords.some(word => description.includes(word));
    if (hasComplexLogic && actions.length < 2) {
      confidenceScore -= 0.08;
      issues.push("描述较复杂但解析结果过于简单");
    }

    // 确保置信度在 0-1 范围内
    confidenceScore = Math.max(0, Math.min(1, confidenceScore));

    // 记录分析过程（用于调试和优化）
    console.log(`[ParsingConfidence] 描述: "${description.slice(0, 50)}..." | 置信度: ${confidenceScore.toFixed(2)} | 问题: [${issues.join(', ')}]`);

    return confidenceScore;
  }

  /**
   * 记录解析分析数据用于持续优化
   */
  private logParsingAnalytics(memberId: string, description: string, routine: Routine, confidence: number, hasWarnings: boolean): void {
    try {
      const analytics = {
        memberId,
        descriptionLength: description.length,
        confidence,
        hasWarnings,
        actionsCount: routine.actions?.length || 0,
        hasTime: !!routine.time,
        hasTimeSlot: !!routine.timeSlot,
        weekdaysCount: routine.weekdays?.length || 0,
        titleLength: routine.title?.length || 0,
        timestamp: new Date().toISOString(),
      };

      // 记录到数据库中（可以用于后续分析和模型优化）
      // 使用现有的saveConversationLog方法记录分析数据
      this.db.saveConversationLog(memberId, description, 'habit_parsing_analytics', JSON.stringify(analytics));
    } catch (error) {
      console.error('[ParsingAnalytics] 记录解析分析数据失败:', error);
    }
  }

  /**
   * 智能判断是否需要强制添加notify动作
   */
  private shouldRequireNotifyAction(actions: RoutineAction[], description: string): boolean {
    // 检查是否有需要用户知晓结果的动作类型
    const hasUserVisibleActions = actions.some(action => {
      // ai_task 通常需要用户知晓结果
      if (action.type === 'ai_task') {
        // 检查prompt是否涉及用户关心的信息
        const prompt = action.prompt?.toLowerCase() || '';
        const userCareKeywords = ['天气', '新闻', '提醒', '通知', '告诉', '查询', '获取', '播报'];
        return userCareKeywords.some(keyword => prompt.includes(keyword));
      }
      
      // plugin 类型需要根据具体功能判断
      if (action.type === 'plugin') {
        const toolName = action.toolName?.toLowerCase() || '';
        // 信息获取类插件通常需要用户知晓
        const infoCareTools = ['weather', 'news', 'stock', 'calendar'];
        return infoCareTools.some(tool => toolName.includes(tool));
      }
      
      return false;
    });

    // 分析习惯描述中的意图
    const descLower = description.toLowerCase();
    
    // 明确的静默执行关键词
    const silentKeywords = ['自动', '静默', '后台', '同步', '备份', '清理'];
    const isSilentTask = silentKeywords.some(keyword => descLower.includes(keyword));
    
    // 明确的通知需求关键词
    const notifyKeywords = ['提醒', '通知', '告诉', '播报', '发送', '推送'];
    const needsNotification = notifyKeywords.some(keyword => descLower.includes(keyword));
    
    // 判断逻辑：
    // 1. 如果明确要求静默执行，不添加notify
    if (isSilentTask && !needsNotification) {
      return false;
    }
    
    // 2. 如果明确要求通知，或有用户关心的动作，添加notify
    if (needsNotification || hasUserVisibleActions) {
      return true;
    }
    
    // 3. 如果没有任何动作，或只有自动化动作，不强制添加notify
    if (actions.length === 0) {
      return true; // 空习惯仍需要基础通知
    }
    
    // 4. 默认情况：有动作但不确定用户意图时，保守添加notify
    return true;
  }

  /**
   * 多层降级解析方法
   */
  private async parseRoutineDescriptionWithMultiLayerFallback(
    memberId: string, 
    description: string, 
    reason: string
  ): Promise<{ routine: Routine; warnings: string[] }> {
    console.log(`[MultiLayerFallback] 开始降级解析，原因: ${reason}`);
    
    // 第1层：简化Agent解析（减少工具数量，降低复杂度）
    try {
      console.log("[MultiLayerFallback] 尝试第1层：简化Agent解析");
      const simpleResult = await this.parseWithSimplifiedAgent(memberId, description);
      if (simpleResult) {
        console.log("[MultiLayerFallback] 第1层成功");
        return { ...simpleResult, warnings: [...(simpleResult.warnings || []), "使用了简化解析模式"] };
      }
    } catch (error) {
      console.warn("[MultiLayerFallback] 第1层失败:", error);
    }
    
    // 第2层：规则解析（基于关键词和模式匹配）
    try {
      console.log("[MultiLayerFallback] 尝试第2层：规则解析");
      const ruleResult = await this.parseWithRules(memberId, description);
      if (ruleResult) {
        console.log("[MultiLayerFallback] 第2层成功");
        return { ...ruleResult, warnings: [...(ruleResult.warnings || []), "使用了规则解析模式"] };
      }
    } catch (error) {
      console.warn("[MultiLayerFallback] 第2层失败:", error);
    }
    
    // 第3层：纯通知模式（最后兜底）
    console.log("[MultiLayerFallback] 使用第3层：纯通知模式");
    return this.parseWithNotificationOnly(memberId, description);
  }

  /**
   * 第1层：简化Agent解析（减少工具复杂度）
   */
  private async parseWithSimplifiedAgent(memberId: string, description: string): Promise<{ routine: Routine; warnings: string[] } | null> {
    try {
      const member = this.familyManager.getMember(memberId);
      const { display, iso } = this.formatNow();
      
      // 只使用核心解析工具，去掉复杂的插件验证
      const simplifiedTools = [
        {
          name: "parse_simple_routine",
          description: "解析用户的习惯描述为结构化格式",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "习惯名称" },
              weekdays: { type: "array", items: { type: "number" }, description: "重复周期，0=周日" },
              time: { type: "string", description: "执行时间，HH:MM格式" },
              actionType: { 
                type: "string", 
                enum: ["notify_only", "ai_task", "plugin"],
                description: "动作类型：notify_only=仅通知，ai_task=AI任务，plugin=插件工具" 
              },
              content: { type: "string", description: "具体内容或任务描述" },
              toolHint: { type: "string", description: "如果需要插件，建议的工具名称" },
            },
            required: ["title", "weekdays", "actionType", "content"],
          },
          execute: async (params: any) => {
            const result = {
              title: params.title as string,
              weekdays: params.weekdays as number[],
              time: params.time as string | undefined,
              actionType: params.actionType as string,
              content: params.content as string,
              toolHint: params.toolHint as string | undefined,
            };
            return { content: JSON.stringify(result, null, 2) };
          },
        },
      ];
      
      const simpleSession = createAgentSession({
        provider: this.getProvider(),
        systemPrompt: [
          "你是习惯解析助手。将用户的自然语言描述转为结构化格式。",
          `当前时间: ${display}`,
          member ? `当前成员: ${member.name}` : "",
          "",
          "# 任务",
          "使用parse_simple_routine工具解析用户描述",
          "",
          "# 动作类型选择",
          "- notify_only: 仅发送提醒通知",
          "- ai_task: 需要AI执行任务（如查询天气、新闻等）", 
          "- plugin: 需要调用特定工具（如news_fetch、weather_query）",
        ].join("\n"),
        tools: simplifiedTools,
        maxTurns: 3,
      });
      
      await simpleSession.prompt(`解析这个习惯：${description}`);
      
      // 提取工具调用结果
      const messages = simpleSession.getMessages();
      for (const message of messages) {
        if (message.role === "tool" && message.content) {
          try {
            const parsed = JSON.parse(message.content);
            return this.convertSimplifiedResult(parsed, description);
          } catch (e) {
            continue;
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error("[SimpleAgent] 解析失败:", error);
      return null;
    }
  }

  /**
   * 第2层：规则解析（基于关键词匹配）
   */
  private async parseWithRules(memberId: string, description: string): Promise<{ routine: Routine; warnings: string[] } | null> {
    try {
      const warnings: string[] = [];
      const desc = description.toLowerCase();
      
      // 提取标题（取前50个字符作为标题）
      const title = description.slice(0, 50).trim() || "自定义习惯";
      
      // 解析时间
      let time: string | undefined;
      let weekdays: number[] = [];
      
      // 时间匹配
      const timePatterns = [
        /(\d{1,2})[点时](\d{1,2})?分?/g,
        /(\d{1,2}):(\d{2})/g,
        /早上(\d{1,2})[点时]/g,
        /下午(\d{1,2})[点时]/g,
        /晚上(\d{1,2})[点时]/g,
      ];
      
      for (const pattern of timePatterns) {
        const match = pattern.exec(desc);
        if (match) {
          let hour = parseInt(match[1]);
          const minute = match[2] ? parseInt(match[2]) : 0;
          
          // 处理上午/下午/晚上
          if (desc.includes("下午") && hour < 12) hour += 12;
          if (desc.includes("晚上") && hour < 12) hour += 12;
          
          if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
            time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            break;
          }
        }
      }
      
      // 周期匹配
      const weekdayPatterns = {
        '周日': 0, '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6,
        '星期日': 0, '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4, '星期五': 5, '星期六': 6,
      };
      
      for (const [pattern, day] of Object.entries(weekdayPatterns)) {
        if (desc.includes(pattern)) {
          weekdays.push(day);
        }
      }
      
      // 如果没有明确指定，根据关键词推断
      if (weekdays.length === 0) {
        if (desc.includes("每天") || desc.includes("天天")) {
          weekdays = [0, 1, 2, 3, 4, 5, 6];
        } else if (desc.includes("工作日")) {
          weekdays = [1, 2, 3, 4, 5];
        } else if (desc.includes("周末")) {
          weekdays = [0, 6];
        } else {
          weekdays = [0, 1, 2, 3, 4, 5, 6]; // 默认每天
        }
      }
      
      // 检测动作类型和内容
      const actionKeywords = {
        news: ['新闻', '资讯', '头条', '周刊'],
        weather: ['天气', '气温', '穿衣'],
        general: ['提醒', '通知', '告诉'],
      };
      
      let actionType = 'notify';
      let content = title;
      let toolName: string | undefined;
      
      if (actionKeywords.news.some(kw => desc.includes(kw))) {
        actionType = 'ai_task';
        content = '获取新闻资讯';
        toolName = 'news_fetch';
      } else if (actionKeywords.weather.some(kw => desc.includes(kw))) {
        actionType = 'ai_task';
        content = '获取天气信息';
        toolName = 'weather_query';
      }
      
      // 构建动作
      const actions: any[] = [];
      
      if (actionType === 'ai_task') {
        actions.push({
          id: `act_${Date.now().toString(36)}`,
          type: 'ai_task',
          trigger: 'at',
          offsetMinutes: 0,
          prompt: content,
          channel: 'wechat',
        });
        
        actions.push({
          id: `act_${Date.now().toString(36)}_notify`,
          type: 'notify',
          trigger: 'after', 
          offsetMinutes: 0,
          message: '{{result}}',
          channel: 'wechat',
        });
      } else {
        actions.push({
          id: `act_${Date.now().toString(36)}`,
          type: 'notify',
          trigger: 'at',
          offsetMinutes: 0,
          message: content,
          channel: 'wechat',
        });
      }
      
      const routine: Routine = {
        id: `rtn_${Date.now().toString(36)}`,
        title,
        description,
        weekdays,
        time,
        reminders: [],
        actions,
      };
      
      warnings.push("使用了关键词匹配解析，建议检查时间和执行内容是否正确");
      
      return { routine, warnings };
    } catch (error) {
      console.error("[RuleParser] 解析失败:", error);
      return null;
    }
  }

  /**
   * 第3层：纯通知模式（最后兜底）
   */
  private parseWithNotificationOnly(memberId: string, description: string): { routine: Routine; warnings: string[] } {
    const title = description.slice(0, 50).trim() || "自定义提醒";
    
    const routine: Routine = {
      id: `rtn_${Date.now().toString(36)}`,
      title,
      description,
      weekdays: [0, 1, 2, 3, 4, 5, 6], // 默认每天
      time: "09:00", // 默认上午9点
      reminders: [],
      actions: [{
        id: `act_${Date.now().toString(36)}`,
        type: "notify",
        trigger: "at",
        offsetMinutes: 0,
        message: title,
        channel: "wechat",
      }],
    };
    
    const warnings = [
      "所有智能解析都失败了，已创建基础通知提醒",
      "请手动检查并调整时间、周期和内容",
      "如需复杂功能，请切换到结构化配置模式"
    ];
    
    return { routine, warnings };
  }

  /**
   * 转换简化解析结果为完整格式
   */
  private convertSimplifiedResult(parsed: any, description: string): { routine: Routine; warnings: string[] } {
    const warnings: string[] = [];
    const actions: any[] = [];
    
    const baseAction = {
      id: `act_${Date.now().toString(36)}`,
      trigger: "at" as const,
      offsetMinutes: 0,
      channel: "wechat" as const,
    };
    
    switch (parsed.actionType) {
      case "notify_only":
        actions.push({
          ...baseAction,
          type: "notify",
          message: parsed.content,
        });
        break;
        
      case "ai_task":
        actions.push({
          ...baseAction,
          type: "ai_task",
          prompt: parsed.content,
        });
        actions.push({
          id: `act_${Date.now().toString(36)}_notify`,
          type: "notify",
          trigger: "after" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          message: "{{result}}",
        });
        break;
        
      case "plugin":
        if (parsed.toolHint) {
          const toolParams = this.inferToolParameters(parsed.toolHint, description, {});
          actions.push({
            ...baseAction,
            type: "plugin",
            toolName: parsed.toolHint,
            toolParams,
          });
          actions.push({
            id: `act_${Date.now().toString(36)}_notify`,
            type: "notify", 
            trigger: "after" as const,
            offsetMinutes: 0,
            channel: "wechat" as const,
            message: "{{result}}",
          });
        } else {
          warnings.push("未找到合适的插件工具，已改为AI任务模式");
          actions.push({
            ...baseAction,
            type: "ai_task",
            prompt: parsed.content,
          });
        }
        break;
    }
    
    const routine: Routine = {
      id: `rtn_${Date.now().toString(36)}`,
      title: parsed.title || description.slice(0, 50),
      description,
      weekdays: parsed.weekdays || [0, 1, 2, 3, 4, 5, 6],
      time: parsed.time,
      reminders: [],
      actions,
    };
    
    return { routine, warnings };
  }

  /**
   * 降级解析方法（保持原有逻辑）
   */
  private async parseRoutineDescriptionFallback(memberId: string, description: string): Promise<{ routine: Routine; warnings: string[] }> {
    // 保持原有的parseRoutineDescription逻辑作为降级方案
    const member = this.familyManager.getMember(memberId);
    const existing = this.routineEngine.getRoutines(memberId);
    const { display, iso } = this.formatNow();

    const pluginTools = this.pluginHost.getAvailableTools();
    const toolNames = pluginTools.map((t) => t.toolName);
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
        time: "HH:MM",
        actions: [
          { id: "act_yyy", type: "ai_task", trigger: "at", offsetMinutes: 0, prompt: "描述 AI 需要执行的任务" },
          { id: "act_xxx", type: "notify", trigger: "after", offsetMinutes: 0, message: "{{result}}" },
        ],
        warnings: ["如果用户描述的功能没有对应的已安装插件支持，在此列出警告"],
      }, null, 2),
      "",
      "# 规则",
      "1. weekdays: 0=周日, 1=周一, ..., 6=周六",
      "2. time: 24小时制 HH:MM 格式",
      "3. actions 必须包含至少一个 notify 类型（确保用户收到通知）",
      "4. 如果用户描述涉及天气、健身装备、买菜等，生成 ai_task 类型的 action，prompt 中描述任务需求（如「查询明天天气并给出穿衣建议」），运行时 AI 会自动调用对应插件",
      "5. 优先使用 ai_task 而非 plugin 类型，因为 ai_task 更灵活，能综合多个工具",
      "6. 每个 action 的 id 用 act_ 前缀加随机字符串",
      "7. trigger: before=提前, at=准时, after=之后; offsetMinutes 表示提前/延后的分钟数，trigger=at 时 offsetMinutes=0",
      "8. 不要输出 channel 字段，系统会统一处理通知渠道",
      "9. 如果用户描述的功能需要某个插件但该插件未在可用列表中，在 warnings 数组中说明（如「需要天气插件但未安装」）",
      "10. 若包含 ai_task：将 ai_task 设为 trigger='at' offsetMinutes=0；notify 设为 trigger='after' offsetMinutes=0 且 message='{{result}}'",
      "11. 只返回 JSON，不要有任何其他文字",
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

    const text = result.message.content.trim();
    const parsed = this.extractJsonObject<{
      title: string;
      weekdays: number[];
      time?: string;
      actions?: Array<{
        id?: string;
        type: string;
        trigger: string;
        offsetMinutes: number;
        message?: string;
        prompt?: string;
        toolName?: string;
        toolParams?: Record<string, unknown>;
      }>;
      warnings?: string[];
    }>(text);

    const warnings: string[] = parsed.warnings ?? [];

    const routine: Routine = {
      id: `rtn_${Date.now().toString(36)}`,
      title: parsed.title,
      description,
      weekdays: parsed.weekdays ?? [],
      time: parsed.time,
      reminders: [],
      actions: (parsed.actions ?? []).map((a, i) => ({
        id: a.id || `act_${Date.now().toString(36)}_${i}`,
        type: (a.type as "notify" | "plugin" | "ai_task") ?? "notify",
        trigger: (a.trigger as "before" | "at" | "after") ?? "at",
        offsetMinutes: a.offsetMinutes ?? 0,
        channel: "wechat" as const,
        message: a.message,
        prompt: a.prompt,
        toolName: a.toolName,
        toolParams: a.toolParams,
      })),
    };

    // 智能判断是否需要添加notify动作
    if (!routine.actions!.some((a) => a.type === "notify")) {
      const shouldAddNotify = this.shouldRequireNotifyAction(routine.actions!, description);
      
      if (shouldAddNotify) {
        routine.actions!.unshift({
          id: `act_${Date.now().toString(36)}_default`,
          type: "notify",
          trigger: "at",
          offsetMinutes: 0,
          channel: "wechat",
          message: routine.actions!.some((a) => a.type === "ai_task") ? "{{result}}" : routine.title,
        });
      } else {
        warnings.push("此习惯被设计为静默执行（无通知），如需通知请手动添加");
      }
    }

    if (routine.actions!.some((a) => a.type === "ai_task")) {
      routine.actions = routine.actions!.map((a) => {
        if (a.type === "ai_task") {
          return { ...a, trigger: "at", offsetMinutes: 0 };
        }
        if (a.type !== "notify") return a;
        if (!a.message || a.message === routine.title || a.message === "{{result}}") {
          return { ...a, trigger: "after", offsetMinutes: 0, message: "{{result}}" };
        }
        return { ...a, trigger: "after", offsetMinutes: 0 };
      });
    }
    routine.actions = [...routine.actions!].sort((a, b) => {
      const triggerRank: Record<RoutineAction["trigger"], number> = { before: 0, at: 1, after: 2 };
      const triggerDiff = triggerRank[a.trigger] - triggerRank[b.trigger];
      if (triggerDiff !== 0) return triggerDiff;
      const offsetDiff = a.offsetMinutes - b.offsetMinutes;
      if (offsetDiff !== 0) return offsetDiff;
      if (a.type === b.type) return 0;
      if (a.type === "notify") return 1;
      if (b.type === "notify") return -1;
      return 0;
    });

    if (routine.actions!.some((a) => a.type === "ai_task") && toolNames.length === 0) {
      warnings.push("当前没有已安装的插件，AI 任务可能无法调用外部工具");
    }

    return { routine, warnings };
  }

  async parsePlanDescription(memberId: string, description: string): Promise<{ plan: Plan; warnings: string[] }> {
    const member = this.familyManager.getMember(memberId);
    const { display, iso } = this.formatNow();

    const systemPrompt = [
      "你是家庭管家的计划解析器。把自然语言描述解析为单个计划 JSON。",
      `当前时间: ${display} (${iso})`,
      member ? `当前成员: ${member.name}` : "",
      "",
      "# 输出格式",
      JSON.stringify({
        title: "计划标题",
        action: "add",
        date: "YYYY-MM-DD",
        dateRange: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" },
        startTime: "HH:MM",
        endTime: "HH:MM",
        timeSlot: "morning",
        reason: "简短备注",
        warnings: ["无法确定时间时给出说明"],
      }, null, 2),
      "",
      "# 规则",
      "1. action 仅能是 skip/add/modify 之一，默认 add",
      "2. date 与 dateRange 二选一；无法确定时优先给 date=今天",
      "3. startTime/endTime 使用 24 小时 HH:MM；无法确定可省略",
      "4. timeSlot 仅 morning/afternoon/evening，可省略",
      "5. title 必填，简洁准确",
      "6. 只返回 JSON，不要有其他文本",
    ].filter(Boolean).join("\n");

    const provider = this.getProvider();
    const result = await provider.chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: description },
      ],
      maxTokens: 1200,
    });
    this.logProviderUsage(memberId, result.usage);

    const text = result.message.content.trim();
    const parsed = this.extractJsonObject<Plan & { warnings?: string[] }>(text);
    const action = parsed.action === "skip" || parsed.action === "add" || parsed.action === "modify"
      ? parsed.action
      : "add";
    const today = getZonedDateTimeParts(new Date(), this.config.get().timezone || "Asia/Shanghai").date;
    const plan: Plan = {
      id: `pln_${Date.now().toString(36)}`,
      action,
      title: parsed.title || description.slice(0, 20),
      reason: parsed.reason,
      date: parsed.date ?? (parsed.dateRange ? undefined : today),
      dateRange: parsed.dateRange,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      time: parsed.startTime ?? parsed.time,
      timeSlot: parsed.timeSlot,
    };

    return { plan, warnings: parsed.warnings ?? [] };
  }

  private extractJsonObject<T>(text: string): T {
    const first = text.indexOf("{");
    if (first === -1) throw new Error("AI 未能返回有效的 JSON 格式");
    let depth = 0;
    for (let i = first; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
      if (depth === 0) {
        const raw = text.slice(first, i + 1);
        return JSON.parse(raw) as T;
      }
    }
    throw new Error("AI 未能返回完整 JSON");
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
    this.db.close();
  }
}
