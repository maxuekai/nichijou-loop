import type { ToolDefinition, Routine } from "@nichijou/shared";
import { formatDate } from "@nichijou/shared";
import type { RoutineEngine } from "../routine/routine-engine.js";
import type { FamilyManager } from "../family/family-manager.js";

export function createRoutineTools(
  routineEngine: RoutineEngine,
  familyManager: FamilyManager,
): ToolDefinition[] {
  return [
    {
      name: "set_routine",
      description: "设置或修改成员的长期习惯。weekdays 为 0-6（0=周日）",
      parameters: {
        type: "object",
        properties: {
          memberId: { type: "string" },
          routine: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              weekdays: { type: "array", items: { type: "number" } },
              timeSlot: { type: "string", enum: ["morning", "afternoon", "evening"] },
              time: { type: "string", description: "精确时间如 18:30" },
              reminders: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    offsetMinutes: { type: "number" },
                    message: { type: "string" },
                    channel: { type: "string", enum: ["wechat", "dashboard", "both"] },
                  },
                },
              },
              actions: {
                type: "array",
                description: "完整的动作配置数组，支持notify、plugin、ai_task类型",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    type: { type: "string", enum: ["notify", "plugin", "ai_task"] },
                    trigger: { type: "string", enum: ["before", "at", "after"] },
                    offsetMinutes: { type: "number" },
                    channel: { type: "string", enum: ["wechat", "dashboard", "both"] },
                    message: { type: "string", description: "通知消息内容（notify类型使用）" },
                    toolName: { type: "string", description: "插件工具名称（plugin类型使用）" },
                    toolParams: { 
                      type: "object", 
                      description: "插件工具参数（plugin类型使用）",
                      additionalProperties: true 
                    },
                    prompt: { type: "string", description: "AI任务提示词（ai_task类型使用）" },
                  },
                  required: ["id", "type", "trigger"],
                },
              },
            },
            required: ["title", "weekdays"],
          },
        },
        required: ["memberId", "routine"],
      },
      execute: async (params) => {
        const memberId = params.memberId as string;
        const routine = params.routine as Routine;
        routineEngine.setRoutine(memberId, routine);
        return { content: `已设置长期习惯：${routine.title}` };
      },
    },
    {
      name: "archive_routine",
      description: "归档（停用）一个长期习惯",
      parameters: {
        type: "object",
        properties: {
          memberId: { type: "string" },
          routineId: { type: "string" },
        },
        required: ["memberId", "routineId"],
      },
      execute: async (params) => {
        routineEngine.archiveRoutine(params.memberId as string, params.routineId as string);
        return { content: "已归档" };
      },
    },
    {
      name: "get_day_schedule",
      description: "查看某个成员某天由长期习惯生成的实际安排",
      parameters: {
        type: "object",
        properties: {
          memberId: { type: "string" },
          date: { type: "string", description: "日期 YYYY-MM-DD，不传默认今天" },
        },
        required: ["memberId"],
      },
      execute: async (params) => {
        const memberId = params.memberId as string;
        const dateStr = params.date as string | undefined;
        const date = dateStr ? new Date(dateStr) : new Date();
        const schedule = routineEngine.resolveDaySchedule(memberId, date);
        return { content: JSON.stringify(schedule, null, 2) };
      },
    },
    {
      name: "get_family_schedule",
      description: "查看家庭所有成员本周的安排概览",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const members = familyManager.getMembers();
        const today = new Date();
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay());

        const schedule: Record<string, Record<string, unknown>> = {};
        for (const member of members) {
          const days: Record<string, unknown> = {};
          for (let i = 0; i < 7; i++) {
            const d = new Date(weekStart);
            d.setDate(weekStart.getDate() + i);
            const daySchedule = routineEngine.resolveDaySchedule(member.id, d);
            if (daySchedule.items.length > 0) {
              days[formatDate(d)] = daySchedule.items.map((it) => it.title);
            }
          }
          schedule[member.name] = days;
        }
        return { content: JSON.stringify(schedule, null, 2) };
      },
    },
    {
      name: "set_family_routine",
      description: "设置或修改家庭共享习惯，可通过 assigneeMemberIds 分配给多个成员",
      parameters: {
        type: "object",
        properties: {
          routine: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              assigneeMemberIds: { 
                type: "array", 
                items: { type: "string" },
                description: "分配给的家庭成员ID列表"
              },
              weekdays: { type: "array", items: { type: "number" } },
              timeSlot: { type: "string", enum: ["morning", "afternoon", "evening"] },
              time: { type: "string", description: "精确时间如 18:30" },
              reminders: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    offsetMinutes: { type: "number" },
                    message: { type: "string" },
                    channel: { type: "string", enum: ["wechat", "dashboard", "both"] },
                  },
                },
              },
              actions: {
                type: "array",
                description: "完整的动作配置数组，支持notify、plugin、ai_task类型",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    type: { type: "string", enum: ["notify", "plugin", "ai_task"] },
                    trigger: { type: "string", enum: ["before", "at", "after"] },
                    offsetMinutes: { type: "number" },
                    channel: { type: "string", enum: ["wechat", "dashboard", "both"] },
                    message: { type: "string", description: "通知消息内容（notify类型使用）" },
                    toolName: { type: "string", description: "插件工具名称（plugin类型使用）" },
                    toolParams: { 
                      type: "object", 
                      description: "插件工具参数（plugin类型使用）",
                      additionalProperties: true 
                    },
                    prompt: { type: "string", description: "AI任务提示词（ai_task类型使用）" },
                  },
                  required: ["id", "type", "trigger"],
                },
              },
            },
            required: ["title", "weekdays"],
          },
        },
        required: ["routine"],
      },
      execute: async (params) => {
        const routine = params.routine as Routine;
        routineEngine.setSharedRoutine(routine);
        return { content: `已设置家庭习惯：${routine.title}` };
      },
    },
  ];
}
