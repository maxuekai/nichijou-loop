import type { InboundMessage, FamilyMember } from "@nichijou/shared";
import type { Channel } from "./channel.js";
import type { FamilyManager } from "../family/family-manager.js";

export type MessageHandler = (member: FamilyMember, msg: InboundMessage) => Promise<void>;

/**
 * Callback for messages from WeChat connections not yet bound to a member.
 * `send` lets the handler reply directly back to the unbound user.
 */
export type UnboundMessageHandler = (
  channelId: string,
  connectionId: string,
  text: string,
  send: (reply: string) => Promise<void>,
) => Promise<void>;

export class Gateway {
  private channels = new Map<string, Channel>();
  private familyManager: FamilyManager;
  private messageHandler?: MessageHandler;
  private unboundHandler?: UnboundMessageHandler;

  constructor(familyManager: FamilyManager) {
    this.familyManager = familyManager;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onUnboundMessage(handler: UnboundMessageHandler): void {
    this.unboundHandler = handler;
  }

  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
  }

  getChannel(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  hasChannel(id: string): boolean {
    return this.channels.has(id);
  }

  async startAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.start(this);
    }
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
  }

  async handleInbound(msg: InboundMessage): Promise<void> {
    const member = this.familyManager.getMember(msg.memberId);
    if (!member) return;
    if (this.messageHandler) {
      await this.messageHandler(member, msg);
    }
  }

  async handleUnboundInbound(
    channelId: string,
    connectionId: string,
    text: string,
    send: (reply: string) => Promise<void>,
  ): Promise<void> {
    if (this.unboundHandler) {
      await this.unboundHandler(channelId, connectionId, text, send);
    }
  }

  async sendToMember(memberId: string, text: string): Promise<void> {
    const member = this.familyManager.getMember(memberId);
    if (!member) throw new Error(`member not found: ${memberId}`);
    const channelId = member.primaryChannel && this.channels.has(member.primaryChannel)
      ? member.primaryChannel
      : (member.channelBindings.wechat ? "wechat" : "");
    if (!channelId) {
      throw new Error(`no available channel for member ${memberId}`);
    }
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error(`channel not registered: ${channelId}`);
    }
    await channel.send(memberId, text);
  }

  getAllChannelStatuses(): Record<string, ReturnType<Channel["getStatus"]>> {
    const statuses: Record<string, ReturnType<Channel["getStatus"]>> = {};
    for (const [id, channel] of this.channels) {
      statuses[id] = channel.getStatus();
    }
    return statuses;
  }
}
