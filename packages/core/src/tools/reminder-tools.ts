import type { ToolDefinition } from "@nichijou/shared";
import type { ReminderScheduler } from "../reminder/reminder-scheduler.js";

export function createReminderTools(scheduler: ReminderScheduler): ToolDefinition[] {
  return [
    {
      name: "confirm_reminder_time",
      description:
        "在设置提醒前确认用户的时间意图。当用户要求创建提醒时，必须先使用此工具确认时间理解是否正确，然后再调用create_reminder。",
      parameters: {
        type: "object",
        properties: {
          userDescription: { 
            type: "string", 
            description: "用户描述的原始时间表达式（如「明天早上8点」「10分钟后」）" 
          },
          parsedTime: { 
            type: "string", 
            description: "AI解析出的ISO时间字符串（如「2026-04-07T08:00:00」）" 
          },
          friendlyTime: { 
            type: "string", 
            description: "用户友好的时间描述（如「明天（4月7日）早上8:00」「10分钟后（15:30）」）" 
          },
          reminderContent: { 
            type: "string", 
            description: "提醒的具体内容" 
          },
        },
        required: ["userDescription", "parsedTime", "friendlyTime", "reminderContent"],
      },
      execute: async (params) => {
        const userDescription = params.userDescription as string;
        const parsedTime = params.parsedTime as string;
        const friendlyTime = params.friendlyTime as string;
        const reminderContent = params.reminderContent as string;

        // 验证时间格式
        const triggerDate = new Date(parsedTime);
        if (isNaN(triggerDate.getTime())) {
          return { 
            content: `时间解析错误：「${parsedTime}」不是有效的时间格式。请重新解析用户的时间表达式。`, 
            isError: true 
          };
        }

        // 检查是否是过去时间
        const now = new Date();
        if (triggerDate <= now) {
          return { 
            content: `时间设置错误：解析的时间「${friendlyTime}」已经过去。请重新确认用户的时间意图。`, 
            isError: true 
          };
        }

        // 生成确认信息
        const timeDiff = triggerDate.getTime() - now.getTime();
        let timeDiffDesc: string;
        
        if (timeDiff < 60000) {
          timeDiffDesc = `${Math.round(timeDiff / 1000)}秒后`;
        } else if (timeDiff < 3600000) {
          timeDiffDesc = `${Math.round(timeDiff / 60000)}分钟后`;
        } else if (timeDiff < 86400000) {
          const h = Math.floor(timeDiff / 3600000);
          const m = Math.round((timeDiff % 3600000) / 60000);
          timeDiffDesc = m > 0 ? `${h}小时${m}分钟后` : `${h}小时后`;
        } else {
          const days = Math.floor(timeDiff / 86400000);
          const hours = Math.floor((timeDiff % 86400000) / 3600000);
          timeDiffDesc = hours > 0 ? `${days}天${hours}小时后` : `${days}天后`;
        }

        const confirmationMessage = `我理解您要在「${friendlyTime}」（${timeDiffDesc}）设置提醒：「${reminderContent}」\n\n时间理解是否正确？如果正确，我将立即创建这个提醒；如果不对，请重新告诉我正确的时间。`;

        return { 
          content: confirmationMessage,
          isError: false,
          // 返回解析结果供后续create_reminder使用
          metadata: {
            parsedTime,
            reminderContent,
            needsUserConfirmation: true
          }
        };
      },
    },
    {
      name: "create_reminder",
      description:
        "创建一个未来时间的个人提醒事项，在指定时间向当前成员发送提醒消息。" +
        "使用场景：" +
        "• 未来某个时间点的个人提醒（「明天早上8点提醒我开会」「下午3点提醒我取快递」）" +
        "• 延时提醒（「10分钟后提醒我关火」「1小时后提醒我查看邮件」）" +
        "• 定时任务提醒（「每天晚上9点提醒我写日记」）" +
        "关键词识别：包含「明天」「下午X点」「X分钟后」「X小时后」等未来时间词汇时使用。" +
        "注意：仅用于给自己设置提醒，不适用于立即通知他人，那种情况请使用send_message工具。" +
        "重要流程：" +
        "1. 在调用create_reminder之前，必须先调用confirm_reminder_time确认时间" +
        "2. 只有用户明确确认时间理解正确后，才能调用此工具创建提醒" +
        "3. 如果用户还没有确认时间，请先询问时间确认",
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
