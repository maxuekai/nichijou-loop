import yaml from "js-yaml";
import { formatDate, generateId } from "@nichijou/shared";
import type { Routine, Plan, DayPlan, DayPlanItem, ReminderRule } from "@nichijou/shared";
import type { StorageManager } from "../storage/storage.js";

export class RoutineEngine {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  getRoutines(memberId: string): Routine[] {
    const own = this.getOwnRoutines(memberId).filter((r) => !r.archived);
    const shared = this.getSharedRoutines()
      .filter((r) => !r.archived)
      .filter((r) => this.isAssignedToMember(r.assigneeMemberIds, memberId));
    return [...own, ...shared];
  }

  getOwnRoutines(memberId: string): Routine[] {
    const content = this.storage.readText(`family/members/${memberId}.routines.yaml`);
    if (!content) return [];
    const data = yaml.load(content) as { routines?: Routine[] };
    return data?.routines ?? [];
  }

  getSharedRoutines(): Routine[] {
    const content = this.storage.readText("family/shared-routines.yaml");
    if (!content) return [];
    const data = yaml.load(content) as { routines?: Routine[] };
    return data?.routines ?? [];
  }

  setRoutine(memberId: string, routine: Routine): void {
    const routines = this.getOwnRoutines(memberId);
    const idx = routines.findIndex((r) => r.id === routine.id);
    if (idx >= 0) {
      routines[idx] = routine;
    } else {
      routines.push({ ...routine, id: routine.id || generateId("rtn") });
    }
    this.saveRoutines(memberId, routines);
  }

  setSharedRoutine(routine: Routine): void {
    const routines = this.getSharedRoutines();
    const idx = routines.findIndex((r) => r.id === routine.id);
    if (idx >= 0) {
      routines[idx] = routine;
    } else {
      routines.push({ ...routine, id: routine.id || generateId("rtn") });
    }
    this.saveSharedRoutines(routines);
  }

  deleteRoutine(memberId: string, routineId: string): void {
    const routines = this.getOwnRoutines(memberId);
    const filtered = routines.filter((r) => r.id !== routineId);
    if (filtered.length === routines.length) throw new Error("Routine not found");
    this.saveRoutines(memberId, filtered);
  }

  deleteSharedRoutine(routineId: string): void {
    const routines = this.getSharedRoutines();
    const filtered = routines.filter((r) => r.id !== routineId);
    if (filtered.length === routines.length) throw new Error("Routine not found");
    this.saveSharedRoutines(filtered);
  }

  archiveRoutine(memberId: string, routineId: string): void {
    const routines = this.getOwnRoutines(memberId);
    const routine = routines.find((r) => r.id === routineId);
    if (routine) {
      routine.archived = true;
      this.saveRoutines(memberId, routines);
    }
  }

  getPlans(memberId: string): Plan[] {
    const own = this.getOwnPlans(memberId);
    const shared = this.getSharedPlans()
      .filter((o) => this.isAssignedToMember(o.assigneeMemberIds, memberId));
    return [...own, ...shared];
  }

  getOwnPlans(memberId: string): Plan[] {
    const content = this.storage.readText(`family/members/${memberId}.plans.yaml`)
      ?? this.storage.readText(`family/members/${memberId}.overrides.yaml`);
    if (!content) return [];
    const data = yaml.load(content) as { plans?: Plan[]; overrides?: Plan[] };
    return data?.plans ?? data?.overrides ?? [];
  }

  getSharedPlans(): Plan[] {
    const content = this.storage.readText("family/shared-plans.yaml")
      ?? this.storage.readText("family/shared-overrides.yaml");
    if (!content) return [];
    const data = yaml.load(content) as { plans?: Plan[]; overrides?: Plan[] };
    return data?.plans ?? data?.overrides ?? [];
  }

  addPlan(memberId: string, plan: Plan): void {
    const plans = this.getOwnPlans(memberId);
    plans.push({ ...plan, id: plan.id || generateId("pln") });
    this.savePlans(memberId, plans);
  }

  addSharedPlan(plan: Plan): void {
    const plans = this.getSharedPlans();
    plans.push({ ...plan, id: plan.id || generateId("pln") });
    this.saveSharedPlans(plans);
  }

  updatePlan(memberId: string, planId: string, data: Partial<Plan>): void {
    const plans = this.getOwnPlans(memberId);
    const idx = plans.findIndex((o) => o.id === planId);
    if (idx === -1) {
      this.addPlan(memberId, { ...data, id: planId } as Plan);
      return;
    }
    plans[idx] = { ...plans[idx]!, ...data, id: planId };
    this.savePlans(memberId, plans);
  }

  updateSharedPlan(planId: string, data: Partial<Plan>): void {
    const plans = this.getSharedPlans();
    const idx = plans.findIndex((o) => o.id === planId);
    if (idx === -1) {
      this.addSharedPlan({ ...data, id: planId } as Plan);
      return;
    }
    plans[idx] = { ...plans[idx]!, ...data, id: planId };
    this.saveSharedPlans(plans);
  }

  removePlan(memberId: string, planId: string): boolean {
    const plans = this.getOwnPlans(memberId);
    const filtered = plans.filter((o) => o.id !== planId);
    if (filtered.length === plans.length) return false;
    this.savePlans(memberId, filtered);
    return true;
  }

  removeSharedPlan(planId: string): boolean {
    const plans = this.getSharedPlans();
    const filtered = plans.filter((o) => o.id !== planId);
    if (filtered.length === plans.length) return false;
    this.saveSharedPlans(filtered);
    return true;
  }

  // Backward compatibility wrappers
  getOverrides(memberId: string): Plan[] { return this.getPlans(memberId); }
  getOwnOverrides(memberId: string): Plan[] { return this.getOwnPlans(memberId); }
  getSharedOverrides(): Plan[] { return this.getSharedPlans(); }
  addOverride(memberId: string, override: Plan): void { this.addPlan(memberId, override); }
  addSharedOverride(override: Plan): void { this.addSharedPlan(override); }
  updateOverride(memberId: string, overrideId: string, data: Partial<Plan>): void { this.updatePlan(memberId, overrideId, data); }
  updateSharedOverride(overrideId: string, data: Partial<Plan>): void { this.updateSharedPlan(overrideId, data); }
  removeOverride(memberId: string, overrideId: string): boolean { return this.removePlan(memberId, overrideId); }
  removeSharedOverride(overrideId: string): boolean { return this.removeSharedPlan(overrideId); }

  resolveEffectiveRoutines(memberId: string, date: Date): Routine[] {
    const weekday = date.getDay();
    const dateStr = formatDate(date);
    const routines = this.getRoutines(memberId);
    const plans = this.getPlans(memberId);

    const activeRoutines = routines
      .filter((r) => r.weekdays.includes(weekday))
      .filter((r) => !this.isSkipped(r, dateStr, plans))
      .map((r) => this.applyModifications(r, dateStr, plans));

    const additions = plans
      .filter((p) => this.matchesDate(p, dateStr) && p.action === "add")
      .map((p) => this.planToRoutine(p, weekday));

    return [...activeRoutines, ...additions].filter((r) => !r.archived);
  }

  resolveDayPlan(memberId: string, date: Date): DayPlan {
    const dateStr = formatDate(date);
    const plans = this.getPlans(memberId);
    const activeRoutines = this.resolveEffectiveRoutines(memberId, date)
      .filter((r) => !r.id.startsWith("plan_"));
    const additions = plans
      .filter((o) => this.matchesDate(o, dateStr) && o.action === "add")
      .map((o) => this.planToItem(o));

    const items: DayPlanItem[] = [
      ...activeRoutines.map((r) => this.routineToItem(r)),
      ...additions,
    ];

    return { date: dateStr, memberId, items };
  }

  cleanExpiredOverrides(memberId: string): number {
    const overrides = this.getOwnPlans(memberId);
    const today = formatDate(new Date());
    const active = overrides.filter((o) => {
      if (o.dateRange) return o.dateRange.end >= today;
      if (o.date) return o.date >= today;
      return true;
    });
    const removed = overrides.length - active.length;
    if (removed > 0) this.savePlans(memberId, active);
    return removed;
  }

  private isSkipped(routine: Routine, dateStr: string, plans: Plan[]): boolean {
    return plans.some((p) => {
      if (p.action !== "skip" || !this.matchesDate(p, dateStr)) return false;
      if (p.routineId && p.routineId !== routine.id) return false;
      return this.matchesPlanTimeWindow(this.resolveRoutineTime(routine), p);
    });
  }

  private applyModifications(routine: Routine, dateStr: string, plans: Plan[]): Routine {
    const mod = plans.find(
      (p) => p.action === "modify"
        && this.matchesDate(p, dateStr)
        && (!p.routineId || p.routineId === routine.id)
        && this.matchesPlanTimeWindow(this.resolveRoutineTime(routine), p),
    );
    if (!mod) return routine;
    return {
      ...routine,
      title: mod.title ?? routine.title,
      time: mod.time ?? mod.startTime ?? routine.time,
      timeSlot: (mod.timeSlot as Routine["timeSlot"]) ?? routine.timeSlot,
      actions: mod.actions ?? routine.actions,
      reminders: mod.reminders ?? routine.reminders,
    };
  }

  private matchesDate(plan: Plan, dateStr: string): boolean {
    if (plan.date) return plan.date === dateStr;
    if (plan.dateRange) {
      return dateStr >= plan.dateRange.start && dateStr <= plan.dateRange.end;
    }
    return false;
  }

  private routineToItem(r: Routine): DayPlanItem {
    return {
      id: r.id,
      title: r.title,
      timeSlot: r.timeSlot,
      time: r.time,
      source: r.assigneeMemberIds ? "family_routine" : "routine",
      routineId: r.id,
      reminders: r.reminders,
    };
  }

  private planToItem(o: Plan): DayPlanItem {
    return {
      id: o.id,
      title: o.title ?? "计划安排",
      time: o.time ?? o.startTime,
      timeSlot: o.timeSlot,
      source: o.assigneeMemberIds ? "family_plan" : "plan",
      reminders: o.reminders ?? [],
    };
  }

  private planToRoutine(plan: Plan, weekday: number): Routine {
    return {
      id: `plan_${plan.id}`,
      title: plan.title ?? "计划安排",
      description: plan.reason,
      assigneeMemberIds: plan.assigneeMemberIds,
      weekdays: [weekday],
      time: plan.time ?? plan.startTime,
      timeSlot: plan.timeSlot as Routine["timeSlot"] | undefined,
      reminders: plan.reminders ?? [],
      actions: plan.actions,
    };
  }

  private saveRoutines(memberId: string, routines: Routine[]): void {
    this.storage.writeText(
      `family/members/${memberId}.routines.yaml`,
      yaml.dump({ routines }),
    );
  }

  private savePlans(memberId: string, plans: Plan[]): void {
    this.storage.writeText(
      `family/members/${memberId}.plans.yaml`,
      yaml.dump({ plans }),
    );
    // legacy file for compatibility with old clients
    this.storage.writeText(
      `family/members/${memberId}.overrides.yaml`,
      yaml.dump({ overrides: plans }),
    );
  }

  private saveSharedRoutines(routines: Routine[]): void {
    this.storage.writeText(
      "family/shared-routines.yaml",
      yaml.dump({ routines }),
    );
  }

  private saveSharedPlans(plans: Plan[]): void {
    this.storage.writeText(
      "family/shared-plans.yaml",
      yaml.dump({ plans }),
    );
    this.storage.writeText(
      "family/shared-overrides.yaml",
      yaml.dump({ overrides: plans }),
    );
  }

  private resolveRoutineTime(routine: Routine): string | null {
    if (routine.time) return routine.time;
    if (routine.timeSlot === "morning") return "08:00";
    if (routine.timeSlot === "afternoon") return "14:00";
    if (routine.timeSlot === "evening") return "20:00";
    return null;
  }

  private matchesPlanTimeWindow(routineTime: string | null, plan: Plan): boolean {
    const start = plan.startTime;
    const end = plan.endTime;
    if (!start || !end || !routineTime) return true;
    return routineTime >= start && routineTime <= end;
  }

  private isAssignedToMember(assigneeMemberIds: string[] | undefined, memberId: string): boolean {
    if (!assigneeMemberIds || assigneeMemberIds.length === 0) return true;
    return assigneeMemberIds.includes(memberId);
  }
}
