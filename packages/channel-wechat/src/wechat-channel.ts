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

  private gateway: Gateway | null = null;
  private storage: StorageManager;
  private pendingLogin: {
    client: WeChatClient;
    abort: AbortController;
    connectionId: string;
    qrUrl?: string;
  } | null = null;

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
  }

  async stop(): Promise<void> {
    if (this.pendingLogin) {
      this.pendingLogin.abort.abort();
      this.pendingLogin = null;
    }
    for (const client of this.clients.values()) {
      client.stop();
    }
    this.clients.clear();
    this.connections.clear();
    this.userIdIndex.clear();
    this.memberIdIndex.clear();
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
    if (conn.memberId) this.memberIdIndex.delete(conn.memberId);
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
