import type { ToolDefinition, Routine, Override } from "@nichijou/shared";
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
      description: "设置或修改成员的长期周计划习惯。weekdays 为 0-6（0=周日）",
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
        return { content: `已设置周计划：${routine.title}` };
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
      name: "add_override",
      description: "为成员添加临时计划变动（跳过/新增/修改某天的安排）",
      parameters: {
        type: "object",
        properties: {
          memberId: { type: "string" },
          override: {
            type: "object",
            properties: {
              date: { type: "string", description: "具体日期 YYYY-MM-DD" },
              dateRange: {
                type: "object",
                properties: {
                  start: { type: "string" },
                  end: { type: "string" },
                },
              },
              action: { type: "string", enum: ["skip", "add", "modify"] },
              routineId: { type: "string" },
              title: { type: "string" },
              reason: { type: "string" },
              timeSlot: { type: "string" },
              reminders: { type: "array" },
            },
            required: ["action"],
          },
        },
        required: ["memberId", "override"],
      },
      execute: async (params) => {
        const memberId = params.memberId as string;
        const override = params.override as Override;
        routineEngine.addOverride(memberId, override);
        return { content: `已添加临时变动：${override.reason ?? override.action}` };
      },
    },
    {
      name: "get_day_plan",
      description: "查看某个成员某天的实际计划（基础规则 + 覆盖合并后）",
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
        const plan = routineEngine.resolveDayPlan(memberId, date);
        return { content: JSON.stringify(plan, null, 2) };
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
            const plan = routineEngine.resolveDayPlan(member.id, d);
            if (plan.items.length > 0) {
              days[formatDate(d)] = plan.items.map((it) => it.title);
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
    {
      name: "add_family_override",
      description: "为家庭共享计划添加临时变动，可通过 assigneeMemberIds 定向到成员",
      parameters: {
        type: "object",
        properties: {
          override: { type: "object" },
        },
        required: ["override"],
      },
      execute: async (params) => {
        const override = params.override as Override;
        routineEngine.addSharedOverride(override);
        return { content: `已添加家庭临时变动：${override.title ?? override.action}` };
      },
    },
  ];
}
