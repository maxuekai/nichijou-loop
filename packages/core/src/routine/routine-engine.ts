import yaml from "js-yaml";
import { formatDate, generateId } from "@nichijou/shared";
import type { Routine, Override, DayPlan, DayPlanItem, ReminderRule } from "@nichijou/shared";
import type { StorageManager } from "../storage/storage.js";

export class RoutineEngine {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  getRoutines(memberId: string): Routine[] {
    const content = this.storage.readText(`family/members/${memberId}.routines.yaml`);
    if (!content) return [];
    const data = yaml.load(content) as { routines?: Routine[] };
    return (data?.routines ?? []).filter((r) => !r.archived);
  }

  setRoutine(memberId: string, routine: Routine): void {
    const routines = this.getAllRoutines(memberId);
    const idx = routines.findIndex((r) => r.id === routine.id);
    if (idx >= 0) {
      routines[idx] = routine;
    } else {
      routines.push({ ...routine, id: routine.id || generateId("rtn") });
    }
    this.saveRoutines(memberId, routines);
  }

  deleteRoutine(memberId: string, routineId: string): void {
    const routines = this.getAllRoutines(memberId);
    const filtered = routines.filter((r) => r.id !== routineId);
    if (filtered.length === routines.length) throw new Error("Routine not found");
    this.saveRoutines(memberId, filtered);
  }

  archiveRoutine(memberId: string, routineId: string): void {
    const routines = this.getAllRoutines(memberId);
    const routine = routines.find((r) => r.id === routineId);
    if (routine) {
      routine.archived = true;
      this.saveRoutines(memberId, routines);
    }
  }

  getOverrides(memberId: string): Override[] {
    const content = this.storage.readText(`family/members/${memberId}.overrides.yaml`);
    if (!content) return [];
    const data = yaml.load(content) as { overrides?: Override[] };
    return data?.overrides ?? [];
  }

  addOverride(memberId: string, override: Override): void {
    const overrides = this.getOverrides(memberId);
    overrides.push({ ...override, id: override.id || generateId("ovr") });
    this.saveOverrides(memberId, overrides);
  }

  resolveDayPlan(memberId: string, date: Date): DayPlan {
    const weekday = date.getDay();
    const dateStr = formatDate(date);
    const routines = this.getRoutines(memberId);
    const overrides = this.getOverrides(memberId);

    const activeRoutines = routines
      .filter((r) => r.weekdays.includes(weekday))
      .filter((r) => !this.isSkipped(r.id, dateStr, overrides))
      .map((r) => this.applyModifications(r, dateStr, overrides));

    const additions = overrides
      .filter((o) => this.matchesDate(o, dateStr) && o.action === "add")
      .map((o) => this.overrideToItem(o));

    const items: DayPlanItem[] = [
      ...activeRoutines.map((r) => this.routineToItem(r)),
      ...additions,
    ];

    return { date: dateStr, memberId, items };
  }

  cleanExpiredOverrides(memberId: string): number {
    const overrides = this.getOverrides(memberId);
    const today = formatDate(new Date());
    const active = overrides.filter((o) => {
      if (o.dateRange) return o.dateRange.end >= today;
      if (o.date) return o.date >= today;
      return true;
    });
    const removed = overrides.length - active.length;
    if (removed > 0) this.saveOverrides(memberId, active);
    return removed;
  }

  private getAllRoutines(memberId: string): Routine[] {
    const content = this.storage.readText(`family/members/${memberId}.routines.yaml`);
    if (!content) return [];
    const data = yaml.load(content) as { routines?: Routine[] };
    return data?.routines ?? [];
  }

  private isSkipped(routineId: string, dateStr: string, overrides: Override[]): boolean {
    return overrides.some(
      (o) => o.routineId === routineId && o.action === "skip" && this.matchesDate(o, dateStr),
    );
  }

  private applyModifications(routine: Routine, dateStr: string, overrides: Override[]): Routine {
    const mod = overrides.find(
      (o) => o.routineId === routine.id && o.action === "modify" && this.matchesDate(o, dateStr),
    );
    if (!mod) return routine;
    return {
      ...routine,
      timeSlot: (mod.timeSlot as Routine["timeSlot"]) ?? routine.timeSlot,
      reminders: mod.reminders ?? routine.reminders,
    };
  }

  private matchesDate(override: Override, dateStr: string): boolean {
    if (override.date) return override.date === dateStr;
    if (override.dateRange) {
      return dateStr >= override.dateRange.start && dateStr <= override.dateRange.end;
    }
    return false;
  }

  private routineToItem(r: Routine): DayPlanItem {
    return {
      id: r.id,
      title: r.title,
      timeSlot: r.timeSlot,
      time: r.time,
      source: "routine",
      routineId: r.id,
      reminders: r.reminders,
    };
  }

  private overrideToItem(o: Override): DayPlanItem {
    return {
      id: o.id,
      title: o.title ?? "临时安排",
      timeSlot: o.timeSlot,
      source: "override",
      reminders: o.reminders ?? [],
    };
  }

  private saveRoutines(memberId: string, routines: Routine[]): void {
    this.storage.writeText(
      `family/members/${memberId}.routines.yaml`,
      yaml.dump({ routines }),
    );
  }

  private saveOverrides(memberId: string, overrides: Override[]): void {
    this.storage.writeText(
      `family/members/${memberId}.overrides.yaml`,
      yaml.dump({ overrides }),
    );
  }
}
