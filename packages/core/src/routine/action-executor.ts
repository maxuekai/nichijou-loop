import cron from "node-cron";
import type { Routine, RoutineAction, ReminderRule } from "@nichijou/shared";
import type { LLMProvider } from "@nichijou/ai";
import type { RoutineEngine } from "./routine-engine.js";
import type { FamilyManager } from "../family/family-manager.js";
import type { PluginHost } from "../plugin-host/plugin-host.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Database } from "../db/database.js";
import type { ConfigManager } from "../storage/config.js";

type ChatForAction = (memberId: string, prompt: string) => Promise<string>;

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
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const nowHH = get("hour") === "24" ? "00" : get("hour");
    const nowMM = get("minute");
    const y = get("year");
    const mo = get("month");
    const d = get("day");
    const weekday = new Date(`${y}-${mo}-${d}T${nowHH}:${nowMM}:00`).getDay();
    const minuteKey = `${y}-${mo}-${d}T${nowHH}:${nowMM}`;

    const members = this.familyManager.getMembers();
    const currentDate = new Date(`${y}-${mo}-${d}T${nowHH}:${nowMM}:00`);
    for (const member of members) {
      const routines = this.routineEngine.resolveEffectiveRoutines(member.id, currentDate);
      for (const routine of routines) {
        if (!routine.weekdays.includes(weekday)) continue;
        const effectiveTime = this.resolveTime(routine);
        if (!effectiveTime) continue;
        const actions = this.resolveActions(routine);
        for (const action of actions) {
          if (this.shouldFire(effectiveTime, action, nowHH, nowMM)) {
            const already = this.db.wasActionExecutedAt(member.id, routine.id, action.id, minuteKey);
            if (already) continue;
            await this.executeAction(member.id, routine, action, minuteKey);
          }
        }
      }
    }
  }

  private shouldFire(effectiveTime: string, action: RoutineAction, nowHH: string, nowMM: string): boolean {
    const [rH, rM] = effectiveTime.split(":").map(Number) as [number, number];
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

  private async executeAction(memberId: string, routine: Routine, action: RoutineAction, minuteKey: string): Promise<void> {
    console.log(`[ActionExecutor] 执行 action: ${action.type} for routine "${routine.title}" member=${memberId}`);
    let result = "";
    let success = true;

    try {
      switch (action.type) {
        case "notify":
          result = action.message ?? routine.title;
          break;

        case "plugin": {
          if (!action.toolName) {
            result = "toolName not configured";
            success = false;
            break;
          }
          const params = { ...(action.toolParams ?? {}) };
          if (!params.lat && !params.lon && this.configManager) {
            const loc = this.configManager.get().location;
            if (loc) {
              params.lat = loc.lat;
              params.lon = loc.lon;
            }
          }
          const toolResult = await this.pluginHost.executeTool(action.toolName, params);
          result = toolResult.content;
          if (toolResult.isError) success = false;
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
          break;
        }
      }
    } catch (err) {
      result = err instanceof Error ? err.message : String(err);
      success = false;
    }

    if (success && result) {
      try {
        await this.gateway.sendToMember(memberId, result);
      } catch (err) {
        console.error(`[ActionExecutor] sendToMember failed:`, err);
      }
    }

    this.db.logActionExecution(memberId, routine.id, action.id, result, success, minuteKey);
  }
}
