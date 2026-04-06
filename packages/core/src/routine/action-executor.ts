import cron from "node-cron";
import type { Routine, RoutineAction } from "@nichijou/shared";
import type { LLMProvider } from "@nichijou/ai";
import type { RoutineEngine } from "./routine-engine.js";
import type { FamilyManager } from "../family/family-manager.js";
import type { PluginHost } from "../plugin-host/plugin-host.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Database } from "../db/database.js";
import type { ConfigManager } from "../storage/config.js";

export class ActionExecutor {
  private cronTask: cron.ScheduledTask | null = null;

  constructor(
    private routineEngine: RoutineEngine,
    private familyManager: FamilyManager,
    private pluginHost: PluginHost,
    private gateway: Gateway,
    private provider: LLMProvider | null,
    private db: Database,
    private configManager?: ConfigManager,
  ) {}

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

  private async tick(): Promise<void> {
    const now = new Date();
    const weekday = now.getDay();
    const nowHH = String(now.getHours()).padStart(2, "0");
    const nowMM = String(now.getMinutes()).padStart(2, "0");
    const minuteKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${nowHH}:${nowMM}`;

    const members = this.familyManager.getMembers();
    for (const member of members) {
      const routines = this.routineEngine.getRoutines(member.id);
      for (const routine of routines) {
        if (!routine.weekdays.includes(weekday)) continue;
        if (!routine.time) continue;
        const actions = routine.actions ?? [];
        for (const action of actions) {
          if (this.shouldFire(routine, action, nowHH, nowMM)) {
            const already = this.db.wasActionExecutedAt(routine.id, action.id, minuteKey);
            if (already) continue;
            await this.executeAction(member.id, routine, action, minuteKey);
          }
        }
      }
    }
  }

  private shouldFire(routine: Routine, action: RoutineAction, nowHH: string, nowMM: string): boolean {
    if (!routine.time) return false;
    const [rH, rM] = routine.time.split(":").map(Number) as [number, number];
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
          await this.gateway.sendToMember(memberId, result);
          break;

        case "plugin":
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
          if (toolResult.isError) {
            success = false;
          } else {
            const channel = action.channel ?? "wechat";
            if (channel !== "dashboard") {
              await this.gateway.sendToMember(memberId, result);
            }
          }
          break;

        case "ai_task":
          if (!this.provider || !action.prompt) {
            result = "provider or prompt not configured";
            success = false;
            break;
          }
          try {
            const resp = await this.provider.chat({
              messages: [
                { role: "system", content: "你是家庭 AI 管家，请根据以下任务简洁回答。" },
                { role: "user", content: action.prompt },
              ],
            });
            result = resp.message.content;
            const channel = action.channel ?? "wechat";
            if (channel !== "dashboard") {
              await this.gateway.sendToMember(memberId, result);
            }
          } catch (err) {
            result = err instanceof Error ? err.message : String(err);
            success = false;
          }
          break;
      }
    } catch (err) {
      result = err instanceof Error ? err.message : String(err);
      success = false;
    }

    this.db.logActionExecution(memberId, routine.id, action.id, result, success);
  }
}
