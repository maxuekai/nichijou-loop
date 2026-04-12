import cron from "node-cron";
import { getZonedDateTimeParts } from "@nichijou/shared";
import type { Routine, RoutineAction, ReminderRule } from "@nichijou/shared";
import type { LLMProvider } from "@nichijou/ai";
import type { RoutineEngine } from "./routine-engine.js";
import type { FamilyManager } from "../family/family-manager.js";
import type { PluginHost } from "../plugin-host/plugin-host.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Database } from "../db/database.js";
import type { ConfigManager } from "../storage/config.js";

type ChatForAction = (memberId: string, prompt: string) => Promise<string>;
interface ActionExecutionContext {
  latestTaskResult?: string;
  hasNotifyAction: boolean;
}

const TIMESLOT_DEFAULTS: Record<string, string> = {
  morning: "08:00",
  afternoon: "14:00",
  evening: "20:00",
};

export class ActionExecutor {
  private cronTask: cron.ScheduledTask | null = null;
  private chatFn: ChatForAction | null = null;

  constructor(
    private routineEngine: RoutineEngine,
    private familyManager: FamilyManager,
    private pluginHost: PluginHost,
    private gateway: Gateway,
    private provider: LLMProvider | null,
    private db: Database,
    private configManager?: ConfigManager,
  ) {}

  setChatFunction(fn: ChatForAction): void {
    this.chatFn = fn;
  }

  start(): void {
    if (this.cronTask) return;
    this.cronTask = cron.schedule("* * * * *", () => {
      this.tick().catch((err) => console.error("[ActionExecutor] tick error:", err));
    });
    console.log("[ActionExecutor] 已启动，每分钟扫描一次 routine actions");
  }

  stop(): void {
    this.cronTask?.stop();
    this.cronTask = null;
  }

  setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  private resolveTime(routine: Routine): string | null {
    if (routine.time) return routine.time;
    if (routine.timeSlot && TIMESLOT_DEFAULTS[routine.timeSlot]) {
      return TIMESLOT_DEFAULTS[routine.timeSlot]!;
    }
    return null;
  }

  private resolveActions(routine: Routine): RoutineAction[] {
    if (routine.actions && routine.actions.length > 0) return routine.actions;
    if (routine.reminders && routine.reminders.length > 0) {
      return routine.reminders.map((r: ReminderRule, i: number) => ({
        id: `migrated_${routine.id}_${i}`,
        type: "notify" as const,
        trigger: "before" as const,
        offsetMinutes: r.offsetMinutes,
        channel: (r.channel as RoutineAction["channel"]) ?? "wechat",
        message: r.message,
      }));
    }
    return [{
      id: `default_notify_${routine.id}`,
      type: "notify" as const,
      trigger: "at" as const,
      offsetMinutes: 0,
      channel: "wechat" as const,
      message: routine.title,
    }];
  }

  private async tick(): Promise<void> {
    const tz = this.configManager?.get().timezone || "Asia/Shanghai";
    const now = getZonedDateTimeParts(new Date(), tz);

    const members = this.familyManager.getMembers();
    for (const member of members) {
      const routines = this.routineEngine.resolveEffectiveRoutines(member.id, new Date(), tz);
      for (const routine of routines) {
        if (!routine.weekdays.includes(now.weekday)) continue;
        const effectiveTime = this.resolveTime(routine);
        if (!effectiveTime) continue;
        const actions = this.resolveActions(routine);
        const dueActions = actions.filter((action) => this.shouldFire(effectiveTime, action, now.hour, now.minute));
        if (dueActions.length === 0) continue;
        const orderedActions = this.orderActionsForExecution(dueActions);
        const context: ActionExecutionContext = {
          hasNotifyAction: orderedActions.some((a) => a.type === "notify"),
        };
        for (const action of orderedActions) {
          const already = this.db.wasActionExecutedAt(member.id, routine.id, action.id, now.minuteKey);
          if (already) continue;
          await this.executeAction(member.id, routine, action, now.minuteKey, context);
        }
      }
    }
  }

  private shouldFire(effectiveTime: string, action: RoutineAction, nowHH: string, nowMM: string): boolean {
    const [rH, rM] = effectiveTime.split(":").map(Number) as [number, number];
    if (!Number.isFinite(rH) || !Number.isFinite(rM)) return false;
    const routineMinutes = rH * 60 + rM;

    let targetMinutes: number;
    if (action.trigger === "before") {
      targetMinutes = routineMinutes - action.offsetMinutes;
    } else if (action.trigger === "after") {
      targetMinutes = routineMinutes + action.offsetMinutes;
    } else {
      targetMinutes = routineMinutes;
    }

    if (targetMinutes < 0) targetMinutes += 1440;
    if (targetMinutes >= 1440) targetMinutes -= 1440;

    const targetHH = String(Math.floor(targetMinutes / 60)).padStart(2, "0");
    const targetMM = String(targetMinutes % 60).padStart(2, "0");

    return nowHH === targetHH && nowMM === targetMM;
  }

  private async executeAction(
    memberId: string,
    routine: Routine,
    action: RoutineAction,
    minuteKey: string,
    context: ActionExecutionContext,
  ): Promise<void> {
    console.log(`[ActionExecutor] 执行 action: ${action.type} for routine "${routine.title}" member=${memberId}`);
    let result = "";
    let success = true;

    try {
      switch (action.type) {
        case "notify": {
          const template = (action.message ?? "").trim();
          if (template.includes("{{result}}")) {
            result = template.replace(/\{\{result\}\}/g, context.latestTaskResult ?? routine.title);
          } else if (template) {
            result = template;
          } else {
            result = context.latestTaskResult ?? routine.title;
          }
          break;
        }

        case "plugin": {
          if (!action.toolName) {
            result = "toolName not configured";
            success = false;
            break;
          }
          const params = { ...(action.toolParams ?? {}) };
          if (action.toolName === "weather_query" && !params.city) {
            const family = this.familyManager.getFamily();
            if (family?.homeAdcode) {
              params.city = family.homeAdcode;
            } else if (family?.homeCity) {
              params.city = family.homeCity;
            }
          }
          const toolResult = await this.pluginHost.executeTool(action.toolName, params);
          result = toolResult.content;
          if (toolResult.isError) success = false;
          if (success && result) context.latestTaskResult = result;
          break;
        }

        case "ai_task": {
          if (!action.prompt) {
            result = "prompt not configured";
            success = false;
            break;
          }
          const taskPrompt = `[定时任务] 习惯「${routine.title}」触发了以下任务，请执行并给出简洁回复：\n\n${action.prompt}`;
          if (this.chatFn) {
            result = await this.chatFn(memberId, taskPrompt);
          } else if (this.provider) {
            const resp = await this.provider.chat({
              messages: [
                { role: "system", content: "你是家庭 AI 管家，请根据以下任务简洁回答。" },
                { role: "user", content: taskPrompt },
              ],
            });
            result = resp.message.content;
          } else {
            result = "no LLM provider configured";
            success = false;
          }
          if (success && result) context.latestTaskResult = result;
          break;
        }
      }
    } catch (err) {
      result = err instanceof Error ? err.message : String(err);
      success = false;
    }

    const channel = action.channel ?? "wechat";
    const shouldSendWeChat = channel === "wechat" || channel === "both";
    const shouldDeferToNotify = action.type !== "notify" && context.hasNotifyAction;
    if (success && result && shouldSendWeChat && !shouldDeferToNotify) {
      try {
        await this.gateway.sendToMember(memberId, result);
      } catch (err) {
        success = false;
        const sendError = err instanceof Error ? err.message : String(err);
        result = `${result}\n[send_error] ${sendError}`;
        console.error(`[ActionExecutor] sendToMember failed:`, err);
      }
    }

    this.db.logActionExecution(memberId, routine.id, action.id, result, success, minuteKey);
  }

  async triggerRoutineNow(memberId: string, routine: Routine): Promise<number> {
    const actions = this.orderActionsForExecution(this.resolveActions(routine));
    const context: ActionExecutionContext = {
      hasNotifyAction: actions.some((a) => a.type === "notify"),
    };
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i]!;
      const executedAt = new Date(Date.now() + i).toISOString();
      await this.executeAction(memberId, routine, action, executedAt, context);
    }
    return actions.length;
  }

  private orderActionsForExecution(actions: RoutineAction[]): RoutineAction[] {
    const triggerRank: Record<RoutineAction["trigger"], number> = {
      before: 0,
      at: 1,
      after: 2,
    };
    const typeRank = (type: RoutineAction["type"]): number => (type === "notify" ? 2 : 1);
    return [...actions].sort((a, b) => {
      const triggerDiff = triggerRank[a.trigger] - triggerRank[b.trigger];
      if (triggerDiff !== 0) return triggerDiff;
      const offsetDiff = a.offsetMinutes - b.offsetMinutes;
      if (offsetDiff !== 0) return offsetDiff;
      return typeRank(a.type) - typeRank(b.type);
    });
  }
}
