import { WeChatClient, MessageType } from "wechat-ilink-client";
import type { WeixinMessage } from "wechat-ilink-client";
import type { ChannelStatus } from "@nichijou/shared";
import { generateId } from "@nichijou/shared";
import type { Channel } from "@nichijou/core";
import type { Gateway } from "@nichijou/core";
import type { StorageManager } from "@nichijou/core";
import type { MemberConnection, WeChatCredentials, WeChatAccount } from "./types.js";

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
  private pendingLogin: {
    client: WeChatClient;
    abort: AbortController;
    connectionId: string;
    qrUrl?: string;
  } | null = null;
  /** Periodic cleanup interval */
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(storage: StorageManager) {
    this.storage = storage;
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
    this.clients.clear();
    this.connections.clear();
    this.userIdIndex.clear();
    this.memberIdIndex.clear();
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

    // Remove old member index if rebound
    if (conn.memberId) {
      this.memberIdIndex.delete(conn.memberId);
    }

    conn.memberId = memberId;
    this.memberIdIndex.set(memberId, connectionId);

    // Update persisted credentials
    const dir = `wechat/connections/${connectionId}`;
    const metaContent = this.storage.readText(`${dir}/meta.json`);
    if (metaContent) {
      try {
        const meta = JSON.parse(metaContent) as { memberId: string | null };
        meta.memberId = memberId;
        this.storage.writeText(`${dir}/meta.json`, JSON.stringify(meta, null, 2));
      } catch { /* ignore */ }
    }

    console.log(`[WeChat] 连接 ${connectionId} 已绑定成员 ${memberId}`);
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
    this.connections.delete(connectionId);

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

      const text = WeChatClient.extractText(msg);
      if (!text || !this.gateway) return;

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
        // Unbound connection: route to binding flow
        await this.gateway.handleUnboundInbound(
          "wechat",
          connId!,
          text,
          async (reply: string) => {
            await client.sendText(fromUserId, reply);
          },
        );
        return;
      }

      await this.gateway.handleInbound({
        channel: "wechat",
        memberId: conn.memberId,
        text,
        contextToken: msg.context_token,
        timestamp: msg.create_time_ms,
      });
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
}
