import type { ToolDefinition } from "@nichijou/shared";
import type { Gateway } from "../gateway/gateway.js";

export function createMessageTools(
  gateway: Gateway,
  clearSessionFn: (memberId: string) => void,
): ToolDefinition[] {
  return [
    {
      name: "send_message",
      description:
        "给家庭成员发送一条微信消息。适用于主动通知、提醒结果转发、跨成员传话等场景。",
      parameters: {
        type: "object",
        properties: {
          memberId: { type: "string", description: "目标成员 ID" },
          message: { type: "string", description: "消息内容" },
        },
        required: ["memberId", "message"],
      },
      execute: async (params) => {
        const memberId = params.memberId as string;
        const message = params.message as string;
        if (!memberId || !message) {
          return { content: "memberId 和 message 不能为空", isError: true };
        }
        try {
          await gateway.sendToMember(memberId, message);
          return { content: `消息已发送给成员 ${memberId}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `发送失败: ${msg}`, isError: true };
        }
      },
    },
    {
      name: "clear_context",
      description:
        "清除指定成员的对话上下文记忆。当成员档案有重大更新、对话出现混乱、或需要重新开始对话时使用。",
      parameters: {
        type: "object",
        properties: {
          memberId: { type: "string", description: "成员 ID" },
        },
        required: ["memberId"],
      },
      execute: async (params) => {
        const memberId = params.memberId as string;
        if (!memberId) {
          return { content: "memberId 不能为空", isError: true };
        }
        clearSessionFn(memberId);
        return { content: `已清除成员 ${memberId} 的对话上下文，下次对话将开始全新会话` };
      },
    },
  ];
}
