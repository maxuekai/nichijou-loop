import { WeChatClient, MessageType } from "wechat-ilink-client";
import type { WeixinMessage } from "wechat-ilink-client";
import type { ChannelStatus, MultimediaConfig } from "@nichijou/shared";
import { generateId } from "@nichijou/shared";
import type { Channel } from "@nichijou/core";
import type { Gateway } from "@nichijou/core";
import type { StorageManager } from "@nichijou/core";
import type { Database } from "@nichijou/core";
import type { MemberConnection, WeChatCredentials, WeChatAccount } from "./types.js";
import { MultimediaMessageParser } from "./multimedia-parser.js";
import type { DownloadProgress, DownloadTask } from "@nichijou/core";

/**
 * WeChat Channel using iLink Bot API via wechat-ilink-client.
 *
 * Architecture: each QR scan produces one WeChatClient (one bot session).
 * A bot session talks to exactly ONE WeChat user. After scanning,
 * the admin binds the connection to a family member.
 */
export class WeChatChannel implements Channel {
  id = "wechat";
  name = "微信 ClawBot";

  private connections = new Map<string, MemberConnection>();
  private clients = new Map<string, WeChatClient>();
  /** wechatUserId → connectionId lookup */
  private userIdIndex = new Map<string, string>();
  /** memberId → connectionId lookup */
  private memberIdIndex = new Map<string, string>();
  /** Cache typing tickets: memberId → ticket */
  private typingTickets = new Map<string, string>();
  /** Cache ticket creation timestamps for expiration: memberId → timestamp */
  private ticketTimestamps = new Map<string, number>();
  /** Track active typing states to avoid duplicates */
  private activeTyping = new Set<string>();
  /** Timeout handles for auto-stopping typing indicators */
  private typingTimeouts = new Map<string, NodeJS.Timeout>();
  /** Debounce map to prevent rapid successive calls: memberId → timestamp of last call */
  private lastTypingCall = new Map<string, number>();

  private gateway: Gateway | null = null;
  private storage: StorageManager;
  private database: Database;
  private multimediaConfig: MultimediaConfig;
  private pendingLogin: {
    client: WeChatClient;
    abort: AbortController;
    connectionId: string;
    qrUrl?: string;
  } | null = null;
  /** Periodic cleanup interval */
  private cleanupInterval: NodeJS.Timeout | null = null;
  /** Multimedia message parsers for each connection */
  private messageParsers = new Map<string, MultimediaMessageParser>();

  constructor(storage: StorageManager, database: Database, multimediaConfig: MultimediaConfig) {
    this.storage = storage;
    this.database = database;
    this.multimediaConfig = multimediaConfig;
  }

  async start(gateway: Gateway): Promise<void> {
    this.gateway = gateway;
    const accounts = this.loadAllAccounts();

    for (const account of accounts) {
      try {
        await this.connectAccount(account);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WeChat] 恢复连接失败 (${account.connectionId}): ${msg}`);
      }
    }

    if (accounts.length > 0) {
      console.log(`[WeChat] 恢复了 ${this.connections.size}/${accounts.length} 个连接`);
    }

    // Start periodic cleanup of expired tickets
    this.startPeriodicCleanup();
  }

  async stop(): Promise<void> {
    if (this.pendingLogin) {
      this.pendingLogin.abort.abort();
      this.pendingLogin = null;
    }
    
    // Stop periodic cleanup
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    for (const client of this.clients.values()) {
      client.stop();
    }
    
    // 清理所有多媒体解析器
    for (const parser of this.messageParsers.values()) {
      parser.destroy();
    }
    
    this.clients.clear();
    this.connections.clear();
    this.userIdIndex.clear();
    this.memberIdIndex.clear();
    this.messageParsers.clear();
    // Clean up all typing states
    this.cleanupTypingState();
  }

  /**
   * Start the QR login flow. Returns the QR URL for display.
   * After the user scans, the connection will appear as "unbound"
   * until bindMember() is called.
   */
  async startPairing(): Promise<{ qrUrl: string; connectionId: string }> {
    if (this.pendingLogin) {
      this.pendingLogin.abort.abort();
      this.pendingLogin = null;
    }

    const connectionId = generateId("wxc");
    const client = new WeChatClient();
    const abort = new AbortController();

    this.pendingLogin = { client, abort, connectionId };

    return new Promise((resolve, reject) => {
      let resolved = false;

      client.login({
        signal: abort.signal,
        onQRCode: (url) => {
          if (this.pendingLogin) this.pendingLogin.qrUrl = url;
          if (!resolved) {
            resolved = true;
            resolve({ qrUrl: url, connectionId });
          }
        },
        onStatus: (s) => {
          console.log(`[WeChat] QR 状态: ${s}`);
        },
      }).then(async (result) => {
        if (result.connected && result.botToken) {
          const wechatUserId = result.userId ?? "";
          const creds: WeChatCredentials = {
            token: result.botToken,
            accountId: result.accountId ?? "",
            baseUrl: result.baseUrl,
            wechatUserId,
          };
          this.saveAccount(connectionId, null, creds);
          await this.connectAccount({
            connectionId,
            memberId: null,
            credentials: creds,
          });
          console.log(`[WeChat] 配对成功 (${connectionId}), 用户: ${wechatUserId}, 等待绑定成员`);
        } else {
          console.warn(`[WeChat] 配对未完成: ${result.message}`);
        }
        this.pendingLogin = null;
      }).catch((err) => {
        if (!abort.signal.aborted) {
          console.error(`[WeChat] 配对错误:`, err);
        }
        this.pendingLogin = null;
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  getPairingStatus(): { active: boolean; connectionId?: string; qrUrl?: string } {
    if (!this.pendingLogin) return { active: false };
    return {
      active: true,
      connectionId: this.pendingLogin.connectionId,
      qrUrl: this.pendingLogin.qrUrl,
    };
  }

  cancelPairing(): void {
    if (this.pendingLogin) {
      this.pendingLogin.abort.abort();
      this.pendingLogin = null;
    }
  }

  /**
   * Bind a connection to a family member.
   * This is the key step: without binding, messages are ignored.
   */
  bindMember(connectionId: string, memberId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`连接不存在: ${connectionId}`);

    for (const other of this.connections.values()) {
      if (other.connectionId === connectionId || other.memberId !== memberId) continue;
      other.memberId = null;
      this.writeConnectionMemberId(other.connectionId, null);
    }

    this.memberIdIndex.delete(memberId);

    // Remove old member index if rebound
    if (conn.memberId) {
      this.memberIdIndex.delete(conn.memberId);
    }

    conn.memberId = memberId;
    this.memberIdIndex.set(memberId, connectionId);

    // Update persisted credentials
    this.writeConnectionMemberId(connectionId, memberId);

    console.log(`[WeChat] 连接 ${connectionId} 已绑定成员 ${memberId}`);
  }

  private writeConnectionMemberId(connectionId: string, memberId: string | null): void {
    const dir = `wechat/connections/${connectionId}`;
    const metaContent = this.storage.readText(`${dir}/meta.json`);
    if (metaContent) {
      try {
        const meta = JSON.parse(metaContent) as { memberId: string | null };
        meta.memberId = memberId;
        this.storage.writeText(`${dir}/meta.json`, JSON.stringify(meta, null, 2));
      } catch { /* ignore */ }
    } else {
      this.storage.writeText(`${dir}/meta.json`, JSON.stringify({ memberId }, null, 2));
    }
  }

  /**
   * Remove a connection entirely: stop the client, delete persisted data.
   */
  removeConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`连接不存在: ${connectionId}`);

    const client = this.clients.get(connectionId);
    if (client) {
      client.stop();
      this.clients.delete(connectionId);
    }

    if (conn.wechatUserId) this.userIdIndex.delete(conn.wechatUserId);
    if (conn.memberId) {
      this.memberIdIndex.delete(conn.memberId);
      // Clean up typing state for this member
      this.cleanupTypingState(conn.memberId);
    }
    
    // 清理多媒体解析器和下载任务
    const parser = this.messageParsers.get(connectionId);
    if (parser) {
      parser.destroy();
    }
    
    this.connections.delete(connectionId);
    this.messageParsers.delete(connectionId);

    this.storage.deleteFile(`wechat/connections/${connectionId}`);
    console.log(`[WeChat] 已删除连接 ${connectionId}`);
  }

  private async connectAccount(account: WeChatAccount): Promise<void> {
    const { connectionId, memberId, credentials } = account;
    const wechatUserId = credentials.wechatUserId ?? "";

    const client = new WeChatClient({
      token: credentials.token,
      accountId: credentials.accountId,
      baseUrl: credentials.baseUrl,
    });

    const connection: MemberConnection = {
      connectionId,
      memberId,
      wechatUserId,
      status: "connected",
      connectedAt: new Date().toISOString(),
    };

    client.on("message", async (msg: WeixinMessage) => {
      if (msg.message_type !== MessageType.USER) return;
      if (!this.gateway) return;

      const fromUserId = msg.from_user_id ?? "";

      // Persist context_token before any routing so it survives restarts
      if (msg.context_token) {
        this.storage.writeText(
          `wechat/connections/${connectionId}/context_token.txt`,
          msg.context_token,
        );
      }

      // Find the connection for this user
      const connId = this.userIdIndex.get(fromUserId);
      const conn = connId ? this.connections.get(connId) : undefined;

      if (!conn?.memberId) {
        // Unbound connection: fallback to simple text extraction for binding flow
        const text = WeChatClient.extractText(msg);
        if (!text) return;

        try {
          if (!connId || !conn) {
            await client.sendText(fromUserId, "当前微信连接已失效，请在管理后台重新扫码后再绑定。");
            return;
          }

          await this.gateway.handleUnboundInbound(
            "wechat",
            connId,
            text,
            async (reply: string) => {
              await client.sendText(fromUserId, reply);
            },
          );
        } catch (error) {
          console.error(`[WeChat] 处理未绑定消息失败 (${connId ?? "unknown"}):`, error);
          try {
            await client.sendText(fromUserId, "当前微信连接处理失败，请在管理后台重新扫码后再试。");
          } catch {
            // ignore reply failure
          }
        }
        return;
      }

      try {
        this.database.recordWechatInboundActivity(conn.memberId);
      } catch (error) {
        console.error(`[WeChat] 记录活跃时间失败 (${conn.memberId}):`, error);
      }

      try {
        // Get or create multimedia parser for this connection
        let parser = this.messageParsers.get(connectionId);
        if (!parser) {
          parser = new MultimediaMessageParser(
            {
              storage: this.storage,
              database: this.database,
              connectionId,
              memberId: conn.memberId,
              maxFileSize: this.multimediaConfig.storage.max_file_size_mb,
              onDownloadProgress: (progress: DownloadProgress) => {
                this.handleDownloadProgress(connectionId, progress);
              },
              onDownloadComplete: (task: DownloadTask, result: any) => {
                this.handleDownloadComplete(connectionId, task, result);
              },
              onDownloadError: (task: DownloadTask, error: Error) => {
                this.handleDownloadError(connectionId, task, error);
              },
            },
            client
          );
          this.messageParsers.set(connectionId, parser);
        }

        // Parse multimedia message
        const parsedMessage = await parser.parseMessage(msg);
        
        if (!parsedMessage.hasContent) {
          console.log(`[WeChat] 忽略空消息: ${connectionId}`);
          return;
        }

        // Build inbound message
        const inboundMessage = parser.buildInboundMessage(parsedMessage, msg);
        
        // Handle the message through gateway
        await this.gateway.handleInbound(inboundMessage);

      } catch (error) {
        console.error(`[WeChat] 处理多媒体消息失败 (${connectionId}):`, error);
        
        // Fallback to simple text processing
        const text = WeChatClient.extractText(msg);
        if (text) {
          await this.gateway.handleInbound({
            channel: "wechat",
            memberId: conn.memberId,
            text,
            contextToken: msg.context_token,
            timestamp: msg.create_time_ms,
          });
        }
      }
    });

    client.on("error", (err: Error) => {
      console.error(`[WeChat] [${connectionId}] 错误:`, err.message);
      connection.lastError = err.message;
    });

    client.on("sessionExpired", () => {
      console.warn(`[WeChat] [${connectionId}] 会话过期，需要重新扫码`);
      connection.status = "expired";
      // Clean up typing state when session expires
      if (connection.memberId) {
        this.cleanupTypingState(connection.memberId);
      }
    });

    const dir = `wechat/connections/${connectionId}`;

    client.start({
      loadSyncBuf: () => {
        const content = this.storage.readText(`${dir}/sync.json`);
        if (!content) return undefined;
        try {
          return (JSON.parse(content) as { buf: string }).buf;
        } catch {
          return undefined;
        }
      },
      saveSyncBuf: (buf: string) => {
        this.storage.writeText(`${dir}/sync.json`, JSON.stringify({ buf }));
      },
    }).catch((err) => {
      console.error(`[WeChat] [${connectionId}] 长轮询启动失败:`, err);
      connection.status = "disconnected";
      connection.lastError = err instanceof Error ? err.message : String(err);
      // Clean up typing state when connection fails
      if (connection.memberId) {
        this.cleanupTypingState(connection.memberId);
      }
    });

    this.clients.set(connectionId, client);
    this.connections.set(connectionId, connection);
    if (wechatUserId) {
      this.userIdIndex.set(wechatUserId, connectionId);
    }
    if (memberId) {
      this.memberIdIndex.set(memberId, connectionId);
    }
  }

  async send(memberId: string, text: string): Promise<void> {
    const connId = this.memberIdIndex.get(memberId);
    if (!connId) {
      throw new Error(`成员 ${memberId} 无微信连接`);
    }
    const conn = this.connections.get(connId);
    const client = this.clients.get(connId);
    if (!client || !conn) throw new Error(`连接 ${connId} 不可用`);

    if (conn.status !== "connected") {
      throw new Error(`连接 ${connId} 状态: ${conn.status}`);
    }

    const toUserId = conn.wechatUserId;
    if (!toUserId) {
      throw new Error(`连接 ${connId} 缺少 wechatUserId`);
    }

    let contextToken = client.getContextToken(toUserId);
    if (!contextToken) {
      const saved = this.storage.readText(`wechat/connections/${connId}/context_token.txt`);
      if (saved) contextToken = saved.trim();
    }
    if (!contextToken) {
      throw new Error(
        `成员 ${memberId} 的微信会话令牌不可用。请先让该成员给机器人发一条消息以建立会话。`,
      );
    }

    await client.sendText(toUserId, text, contextToken);
  }

  async startTyping(memberId: string): Promise<void> {
    try {
      // Debounce: avoid rapid successive calls
      const now = Date.now();
      const lastCall = this.lastTypingCall.get(memberId);
      if (lastCall && (now - lastCall) < 1000) { // 1 second debounce
        return;
      }
      this.lastTypingCall.set(memberId, now);

      // Avoid duplicate typing calls for the same member
      if (this.activeTyping.has(memberId)) {
        return;
      }

      const connId = this.memberIdIndex.get(memberId);
      if (!connId) {
        console.warn(`[WeChat] startTyping: 成员 ${memberId} 无微信连接`);
        return;
      }

      const conn = this.connections.get(connId);
      const client = this.clients.get(connId);
      if (!client || !conn || conn.status !== "connected") {
        console.warn(`[WeChat] startTyping: 连接 ${connId} 不可用或未连接`);
        return;
      }

      const toUserId = conn.wechatUserId;
      if (!toUserId) {
        console.warn(`[WeChat] startTyping: 连接 ${connId} 缺少 wechatUserId`);
        return;
      }

      let contextToken = client.getContextToken(toUserId);
      if (!contextToken) {
        const saved = this.storage.readText(`wechat/connections/${connId}/context_token.txt`);
        if (saved) contextToken = saved.trim();
      }
      if (!contextToken) {
        console.warn(`[WeChat] startTyping: 成员 ${memberId} 无可用会话令牌`);
        return;
      }

      // Get or cache typing ticket (with expiration check)
      let ticket = this.typingTickets.get(memberId);
      const ticketTimestamp = this.ticketTimestamps.get(memberId);
      
      // Check if ticket is expired (30 minutes)
      if (!ticket || !ticketTimestamp || (now - ticketTimestamp) > 30 * 60 * 1000) {
        console.log(`[WeChat] 获取新的 typing ticket (${memberId})`);
        ticket = await client.getTypingTicket(toUserId, contextToken);
        this.typingTickets.set(memberId, ticket);
        this.ticketTimestamps.set(memberId, now);
      }

      // Start typing (status = "typing")
      await client.sendTyping(toUserId, ticket, "typing");
      this.activeTyping.add(memberId);

      // Set timeout to auto-stop typing after 30 seconds
      const existingTimeout = this.typingTimeouts.get(memberId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }
      
      const timeout = setTimeout(async () => {
        console.warn(`[WeChat] 正在输入状态超时，自动停止: ${memberId}`);
        await this.stopTyping(memberId);
      }, 30000); // 30 seconds
      
      this.typingTimeouts.set(memberId, timeout);

      console.log(`[WeChat] 开始显示正在输入状态: ${memberId}`);
    } catch (err) {
      console.error(`[WeChat] startTyping 失败 (${memberId}):`, err);
    }
  }

  async stopTyping(memberId: string): Promise<void> {
    try {
      // Only stop if we were actually typing
      if (!this.activeTyping.has(memberId)) {
        return;
      }

      const connId = this.memberIdIndex.get(memberId);
      if (!connId) {
        console.warn(`[WeChat] stopTyping: 成员 ${memberId} 无微信连接`);
        this.activeTyping.delete(memberId);
        return;
      }

      const conn = this.connections.get(connId);
      const client = this.clients.get(connId);
      if (!client || !conn) {
        console.warn(`[WeChat] stopTyping: 连接 ${connId} 不可用`);
        this.activeTyping.delete(memberId);
        return;
      }

      const toUserId = conn.wechatUserId;
      if (!toUserId) {
        console.warn(`[WeChat] stopTyping: 连接 ${connId} 缺少 wechatUserId`);
        this.activeTyping.delete(memberId);
        return;
      }

      const ticket = this.typingTickets.get(memberId);
      if (!ticket) {
        console.warn(`[WeChat] stopTyping: 无缓存的 typing ticket (${memberId})`);
        this.activeTyping.delete(memberId);
        return;
      }

      // Stop typing (status = "cancel")
      await client.sendTyping(toUserId, ticket, "cancel");
      this.activeTyping.delete(memberId);
      
      // Clear timeout
      const timeout = this.typingTimeouts.get(memberId);
      if (timeout) {
        clearTimeout(timeout);
        this.typingTimeouts.delete(memberId);
      }

      console.log(`[WeChat] 停止显示正在输入状态: ${memberId}`);
    } catch (err) {
      console.error(`[WeChat] stopTyping 失败 (${memberId}):`, err);
      // Always clean up the active state even if the API call failed
      this.activeTyping.delete(memberId);
      
      // Clear timeout even on error
      const timeout = this.typingTimeouts.get(memberId);
      if (timeout) {
        clearTimeout(timeout);
        this.typingTimeouts.delete(memberId);
      }
    }
  }

  /**
   * Clean up typing state for a specific member or all members.
   */
  private cleanupTypingState(memberId?: string): void {
    if (memberId) {
      // Clean up specific member
      this.activeTyping.delete(memberId);
      this.typingTickets.delete(memberId);
      this.ticketTimestamps.delete(memberId);
      this.lastTypingCall.delete(memberId);
      
      const timeout = this.typingTimeouts.get(memberId);
      if (timeout) {
        clearTimeout(timeout);
        this.typingTimeouts.delete(memberId);
      }
    } else {
      // Clean up all typing states
      this.activeTyping.clear();
      this.typingTickets.clear();
      this.ticketTimestamps.clear();
      this.lastTypingCall.clear();
      
      for (const timeout of this.typingTimeouts.values()) {
        clearTimeout(timeout);
      }
      this.typingTimeouts.clear();
    }
  }

  /**
   * Start periodic cleanup of expired tickets and stale states.
   */
  private startPeriodicCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.cleanupInterval = setInterval(() => {
      this.performPeriodicCleanup();
    }, 10 * 60 * 1000); // 10 minutes
  }

  /**
   * Clean up expired tickets and stale typing states.
   */
  private performPeriodicCleanup(): void {
    const now = Date.now();
    const expiredMembers: string[] = [];

    // Check for expired tickets (30 minutes)
    for (const [memberId, timestamp] of this.ticketTimestamps.entries()) {
      if ((now - timestamp) > 30 * 60 * 1000) {
        expiredMembers.push(memberId);
      }
    }

    // Clean up expired members
    for (const memberId of expiredMembers) {
      this.typingTickets.delete(memberId);
      this.ticketTimestamps.delete(memberId);
      console.log(`[WeChat] 清理过期的 typing ticket: ${memberId}`);
    }

    // Clean up stale typing calls (older than 5 minutes)
    for (const [memberId, timestamp] of this.lastTypingCall.entries()) {
      if ((now - timestamp) > 5 * 60 * 1000) {
        this.lastTypingCall.delete(memberId);
      }
    }
  }

  getStatus(): ChannelStatus {
    const conns = [...this.connections.values()];
    const bound = conns.filter((c) => c.memberId);
    return {
      connected: bound.some((c) => c.status === "connected"),
      totalMembers: bound.length,
      connectedMembers: bound.filter((c) => c.status === "connected").length,
      expiredMembers: conns
        .filter((c) => c.status === "expired")
        .map((c) => c.connectionId),
    };
  }

  isMemberBound(memberId: string): boolean {
    return this.memberIdIndex.has(memberId);
  }

  getConnections(): MemberConnection[] {
    return [...this.connections.values()];
  }

  private loadAllAccounts(): WeChatAccount[] {
    const baseDir = "wechat/connections";
    const dirs = this.storage.listDir(baseDir);
    const accounts: WeChatAccount[] = [];

    for (const dir of dirs) {
      const credsContent = this.storage.readText(`${baseDir}/${dir}/credentials.json`);
      const metaContent = this.storage.readText(`${baseDir}/${dir}/meta.json`);
      if (credsContent) {
        try {
          const credentials = JSON.parse(credsContent) as WeChatCredentials;
          let memberId: string | null = null;
          if (metaContent) {
            memberId = (JSON.parse(metaContent) as { memberId: string | null }).memberId;
          }
          accounts.push({ connectionId: dir, memberId, credentials });
        } catch {
          console.warn(`[WeChat] 无法解析 ${dir} 的凭证`);
        }
      }
    }

    return accounts;
  }

  private saveAccount(connectionId: string, memberId: string | null, credentials: WeChatCredentials): void {
    const dir = `wechat/connections/${connectionId}`;
    this.storage.writeText(`${dir}/credentials.json`, JSON.stringify(credentials, null, 2));
    this.storage.writeText(`${dir}/meta.json`, JSON.stringify({ memberId }, null, 2));
  }

  /**
   * 处理下载进度事件
   */
  private async handleDownloadProgress(connectionId: string, progress: DownloadProgress): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn?.memberId) return;

    try {
      // 可以向用户发送下载进度通知（可选）
      if (progress.progress === 0) {
        console.log(`[WeChat] 开始下载: ${progress.taskId} (${conn.memberId})`);
      } else if (progress.progress % 25 === 0) { // 每25%报告一次
        console.log(
          `[WeChat] 下载进度 ${progress.progress}%: ${progress.taskId} ` +
          `(速度: ${this.formatSpeed(progress.speed)}, 剩余: ${this.formatTime(progress.estimatedTimeRemaining)})`
        );
      }
    } catch (error) {
      console.error(`[WeChat] 处理下载进度失败:`, error);
    }
  }

  /**
   * 处理下载完成事件
   */
  private async handleDownloadComplete(connectionId: string, task: DownloadTask, result: any): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn?.memberId) return;

    try {
      const duration = task.endTime ? (task.endTime - task.startTime) / 1000 : 0;
      console.log(
        `[WeChat] 下载完成: ${task.fileName} ` +
        `(大小: ${this.formatFileSize(task.downloadedSize)}, 耗时: ${duration.toFixed(1)}s)`
      );

      // 可以向用户发送下载完成通知（可选）
      // await this.send(conn.memberId, `文件下载完成: ${task.fileName}`);
    } catch (error) {
      console.error(`[WeChat] 处理下载完成事件失败:`, error);
    }
  }

  /**
   * 处理下载错误事件
   */
  private async handleDownloadError(connectionId: string, task: DownloadTask, error: Error): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn?.memberId) return;

    try {
      console.error(`[WeChat] 下载失败: ${task.fileName} - ${error.message}`);

      // 可以向用户发送错误通知（可选）
      // await this.send(conn.memberId, `文件下载失败: ${task.fileName}`);
    } catch (sendError) {
      console.error(`[WeChat] 发送下载错误通知失败:`, sendError);
    }
  }

  /**
   * 获取连接的下载任务
   */
  getConnectionDownloadTasks(connectionId: string): DownloadTask[] {
    const parser = this.messageParsers.get(connectionId);
    return parser ? parser.getMemberDownloadTasks() : [];
  }

  /**
   * 取消连接的下载任务
   */
  cancelConnectionDownloadTask(connectionId: string, taskId: string): boolean {
    const parser = this.messageParsers.get(connectionId);
    return parser ? parser.cancelDownloadTask(taskId) : false;
  }

  /**
   * 取消连接的所有下载任务
   */
  cancelAllConnectionDownloadTasks(connectionId: string): number {
    const parser = this.messageParsers.get(connectionId);
    return parser ? parser.cancelAllDownloadTasks() : 0;
  }

  /**
   * 获取所有下载任务统计
   */
  getAllDownloadStats(): Record<string, any> {
    const stats: Record<string, any> = {};
    
    for (const [connectionId, parser] of this.messageParsers.entries()) {
      stats[connectionId] = parser.getDownloadStats();
    }
    
    return stats;
  }

  /**
   * 格式化文件大小
   */
  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 格式化速度
   */
  private formatSpeed(bytesPerSecond: number): string {
    return this.formatFileSize(bytesPerSecond) + '/s';
  }

  /**
   * 格式化时间
   */
  private formatTime(seconds: number): string {
    if (seconds < 0) return '未知';
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`;
  }
}
