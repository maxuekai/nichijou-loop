import type { ChannelStatus } from "@nichijou/shared";
import type { Gateway } from "./gateway.js";

export interface Channel {
  id: string;
  name: string;
  start(gateway: Gateway): Promise<void>;
  stop(): Promise<void>;
  send(memberId: string, text: string): Promise<void>;
  sendMedia?(memberId: string, filePath: string, caption?: string): Promise<void>;
  startTyping?(memberId: string): Promise<void>;
  stopTyping?(memberId: string): Promise<void>;
  getStatus(): ChannelStatus;
}
