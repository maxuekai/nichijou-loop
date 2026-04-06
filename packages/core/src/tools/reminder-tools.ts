import type { ToolDefinition } from "@nichijou/shared";
import type { ReminderScheduler } from "../reminder/reminder-scheduler.js";

export function createReminderTools(scheduler: ReminderScheduler): ToolDefinition[] {
  return [
    {
      name: "create_reminder",
      description:
        "创建一个提醒事项。在指定的日期时间通过微信发送提醒消息给成员。" +
        "适用于「明天早上8点提醒我开会」「下午3点提醒我取快递」「2分钟后提醒我关火」等需求。" +
        "triggerAt 必须是 ISO 格式的日期时间字符串（如 2026-04-07T08:00:00），请根据当前时间推算。",
      parameters: {
        type: "object",
        properties: {
          memberId: { type: "string", description: "成员 ID" },
          message: { type: "string", description: "提醒内容" },
          triggerAt: {
            type: "string",
            description: "触发时间，ISO datetime 格式，如 2026-04-07T08:00:00。请根据系统提示中的当前时间推算具体日期时间。",
          },
          channel: {
            type: "string",
            enum: ["wechat", "dashboard", "both"],
            description: "提醒通道，默认 wechat",
          },
        },
        required: ["memberId", "message", "triggerAt"],
      },
      execute: async (params) => {
        const memberId = params.memberId as string;
        const message = params.message as string;
        const triggerAt = params.triggerAt as string;
        const channel = (params.channel as "wechat" | "dashboard" | "both") ?? "wechat";

        const triggerDate = new Date(triggerAt);
        if (isNaN(triggerDate.getTime())) {
          return { content: "triggerAt 格式不正确，请使用 ISO datetime 格式（如 2026-04-07T08:00:00）", isError: true };
        }

        const reminder = scheduler.add({ memberId, message, triggerAt, channel });

        const diff = triggerDate.getTime() - Date.now();
        let timeDesc: string;
        if (diff <= 0) {
          timeDesc = "立即";
        } else if (diff < 60000) {
          timeDesc = `${Math.round(diff / 1000)}秒后`;
        } else if (diff < 3600000) {
          timeDesc = `${Math.round(diff / 60000)}分钟后`;
        } else if (diff < 86400000) {
          const h = Math.floor(diff / 3600000);
          const m = Math.round((diff % 3600000) / 60000);
          timeDesc = m > 0 ? `${h}小时${m}分钟后` : `${h}小时后`;
        } else {
          timeDesc = `${triggerAt.replace("T", " ")}`;
        }

        return { content: `已创建提醒（${timeDesc}）：「${message}」\nID: ${reminder.id}` };
      },
    },
    {
      name: "cancel_reminder",
      description: "取消一个提醒事项。需要提供提醒 ID。",
      parameters: {
        type: "object",
        properties: {
          reminderId: { type: "string", description: "提醒 ID" },
        },
        required: ["reminderId"],
      },
      execute: async (params) => {
        const reminderId = params.reminderId as string;
        scheduler.cancel(reminderId);
        return { content: `已取消提醒 ${reminderId}` };
      },
    },
  ];
}
