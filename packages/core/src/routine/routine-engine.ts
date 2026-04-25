import yaml from "js-yaml";
import { formatDate, generateId, getZonedDateTimeParts } from "@nichijou/shared";
import type { DaySchedule, DayScheduleItem, Routine } from "@nichijou/shared";
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

  resolveEffectiveRoutines(memberId: string, date: Date, timeZone?: string): Routine[] {
    const { weekday } = this.resolveDateContext(date, timeZone);
    return this.getRoutines(memberId)
      .filter((r) => r.weekdays.includes(weekday))
      .filter((r) => !r.archived);
  }

  resolveDaySchedule(memberId: string, date: Date, timeZone?: string): DaySchedule {
    const { dateStr } = this.resolveDateContext(date, timeZone);
    const items = this.resolveEffectiveRoutines(memberId, date, timeZone).map((r) => this.routineToItem(r));
    return { date: dateStr, memberId, items };
  }

  private routineToItem(r: Routine): DayScheduleItem {
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

  private saveRoutines(memberId: string, routines: Routine[]): void {
    this.storage.writeText(
      `family/members/${memberId}.routines.yaml`,
      yaml.dump({ routines }),
    );
  }

  private saveSharedRoutines(routines: Routine[]): void {
    this.storage.writeText(
      "family/shared-routines.yaml",
      yaml.dump({ routines }),
    );
  }

  private isAssignedToMember(assigneeMemberIds: string[] | undefined, memberId: string): boolean {
    if (!assigneeMemberIds || assigneeMemberIds.length === 0) return true;
    return assigneeMemberIds.includes(memberId);
  }

  private resolveDateContext(date: Date, timeZone?: string): { weekday: number; dateStr: string } {
    if (!timeZone) {
      return { weekday: date.getDay(), dateStr: formatDate(date) };
    }
    const zoned = getZonedDateTimeParts(date, timeZone);
    return { weekday: zoned.weekday, dateStr: zoned.date };
  }
}
