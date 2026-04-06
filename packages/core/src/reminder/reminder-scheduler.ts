import { randomUUID } from "node:crypto";
import type { Reminder } from "@nichijou/shared";
import type { Database } from "../db/database.js";
import type { Gateway } from "../gateway/gateway.js";

export class ReminderScheduler {
  private db: Database;
  private gateway: Gateway;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(db: Database, gateway: Gateway) {
    this.db = db;
    this.gateway = gateway;
  }

  start(): void {
    const pending = this.db.getPendingReminders();
    let scheduled = 0;
    for (const reminder of pending) {
      this.schedule(reminder);
      scheduled++;
    }
    if (scheduled > 0) {
      console.log(`[Reminder] 恢复了 ${scheduled} 个待触发提醒`);
    }
  }

  add(params: { memberId: string; message: string; triggerAt: string; channel?: "wechat" | "dashboard" | "both" }): Reminder {
    const reminder: Reminder = {
      id: randomUUID().slice(0, 8),
      memberId: params.memberId,
      message: params.message,
      triggerAt: params.triggerAt,
      channel: params.channel ?? "wechat",
      done: false,
      createdAt: new Date().toISOString(),
    };
    this.db.createReminder(reminder);
    this.schedule(reminder);
    return reminder;
  }

  cancel(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.db.deleteReminder(id);
    return true;
  }

  reschedule(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const all = this.db.getReminders();
    const reminder = all.find((r) => r.id === id);
    if (reminder && !reminder.done) {
      this.schedule(reminder);
    }
  }

  private schedule(reminder: Reminder): void {
    const triggerTime = new Date(reminder.triggerAt).getTime();
    const delay = triggerTime - Date.now();

    if (delay <= 0) {
      this.fire(reminder);
      return;
    }

    const maxDelay = 2147483647; // setTimeout max (~24.8 days)
    if (delay > maxDelay) {
      const timer = setTimeout(() => {
        this.timers.delete(reminder.id);
        this.schedule(reminder);
      }, maxDelay);
      this.timers.set(reminder.id, timer);
      return;
    }

    const timer = setTimeout(() => {
      this.timers.delete(reminder.id);
      this.fire(reminder);
    }, delay);
    this.timers.set(reminder.id, timer);
  }

  private async fire(reminder: Reminder): Promise<void> {
    this.db.markReminderDone(reminder.id);
    try {
      await this.gateway.sendToMember(reminder.memberId, `⏰ 提醒：${reminder.message}`);
    } catch (err) {
      console.error(`[Reminder] 发送提醒失败 (${reminder.id}):`, err);
    }
  }

  shutdown(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}
