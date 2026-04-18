import BetterSqlite3 from "better-sqlite3";
import type { StorageManager } from "../storage/storage.js";
import type { Reminder } from "@nichijou/shared";

export interface ChatRecord {
  id: number;
  memberId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface ReminderLog {
  id: number;
  memberId: string;
  routineId: string;
  reminderId: string;
  sentAt: string;
  channel: string;
}

export class Database {
  private db: BetterSqlite3.Database;

  constructor(storage: StorageManager) {
    const dbPath = storage.resolve("db", "nichijou.sqlite");
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chat_member
        ON chat_history(member_id, created_at);

      CREATE TABLE IF NOT EXISTS memory_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_summary_member
        ON memory_summaries(member_id, created_at);

      CREATE TABLE IF NOT EXISTS reminder_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL,
        routine_id TEXT NOT NULL,
        reminder_id TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        channel TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_reminder_member
        ON reminder_logs(member_id, sent_at);

      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_token_usage_date
        ON token_usage(created_at);

      CREATE TABLE IF NOT EXISTS conversation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL,
        user_input TEXT NOT NULL,
        final_reply TEXT NOT NULL,
        events TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_conv_log_member
        ON conversation_logs(member_id, created_at);

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        message TEXT NOT NULL,
        trigger_at TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'wechat',
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_reminders_member
        ON reminders(member_id, trigger_at);

      CREATE TABLE IF NOT EXISTS action_execution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL,
        routine_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        executed_at TEXT NOT NULL DEFAULT (datetime('now')),
        result TEXT,
        success INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_action_exec
        ON action_execution_log(member_id, routine_id, action_id, executed_at);
    `);
  }

  saveChat(memberId: string, role: string, content: string, toolCalls?: string, toolCallId?: string): void {
    this.db.prepare(
      `INSERT INTO chat_history (member_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(memberId, role, content, toolCalls ?? null, toolCallId ?? null);
  }

  getRecentChats(memberId: string, limit = 50): ChatRecord[] {
    return this.db
      .prepare(
        `SELECT id, member_id as memberId, role, content, created_at as createdAt
         FROM chat_history WHERE member_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(memberId, limit) as ChatRecord[];
  }

  saveSummary(memberId: string, summary: string, periodStart: string, periodEnd: string): void {
    this.db
      .prepare(
        `INSERT INTO memory_summaries (member_id, summary, period_start, period_end) VALUES (?, ?, ?, ?)`,
      )
      .run(memberId, summary, periodStart, periodEnd);
  }

  getLatestSummary(memberId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT summary FROM memory_summaries WHERE member_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(memberId) as { summary: string } | undefined;
    return row?.summary ?? null;
  }

  logReminder(memberId: string, routineId: string, reminderId: string, channel: string): void {
    this.db
      .prepare(
        `INSERT INTO reminder_logs (member_id, routine_id, reminder_id, channel) VALUES (?, ?, ?, ?)`,
      )
      .run(memberId, routineId, reminderId, channel);
  }

  isReminderSent(memberId: string, reminderId: string, dateStr: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM reminder_logs
         WHERE member_id = ? AND reminder_id = ? AND sent_at >= ?`,
      )
      .get(memberId, reminderId, dateStr) as { cnt: number };
    return row.cnt > 0;
  }

  logTokenUsage(memberId: string, promptTokens: number, completionTokens: number, model: string): void {
    this.db
      .prepare(
        `INSERT INTO token_usage (member_id, prompt_tokens, completion_tokens, model) VALUES (?, ?, ?, ?)`,
      )
      .run(memberId, promptTokens, completionTokens, model);
  }

  getTokenUsage(since: string): { promptTokens: number; completionTokens: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(prompt_tokens), 0) as promptTokens,
                COALESCE(SUM(completion_tokens), 0) as completionTokens
         FROM token_usage WHERE created_at >= ?`,
      )
      .get(since) as { promptTokens: number; completionTokens: number };
    return row;
  }

  saveConversationLog(memberId: string, userInput: string, finalReply: string, events: string): void {
    this.db.prepare(
      `INSERT INTO conversation_logs (member_id, user_input, final_reply, events) VALUES (?, ?, ?, ?)`,
    ).run(memberId, userInput, finalReply, events);
  }

  getConversationLogs(memberId: string, limit = 50): Array<{
    id: number;
    memberId: string;
    userInput: string;
    finalReply: string;
    events: string;
    createdAt: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, member_id as memberId, user_input as userInput, final_reply as finalReply,
                events, created_at as createdAt
         FROM conversation_logs WHERE member_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(memberId, limit) as Array<{
        id: number;
        memberId: string;
        userInput: string;
        finalReply: string;
        events: string;
        createdAt: string;
      }>;
  }

  getAllConversationLogs(limit = 100): Array<{
    id: number;
    memberId: string;
    userInput: string;
    finalReply: string;
    events: string;
    createdAt: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, member_id as memberId, user_input as userInput, final_reply as finalReply,
                events, created_at as createdAt
         FROM conversation_logs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
        id: number;
        memberId: string;
        userInput: string;
        finalReply: string;
        events: string;
        createdAt: string;
      }>;
  }

  // --- Reminders ---

  createReminder(reminder: Omit<Reminder, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO reminders (id, member_id, message, trigger_at, channel, done) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(reminder.id, reminder.memberId, reminder.message, reminder.triggerAt, reminder.channel, reminder.done ? 1 : 0);
  }

  getReminders(memberId?: string): Reminder[] {
    const sql = memberId
      ? `SELECT id, member_id as memberId, message, trigger_at as triggerAt, channel, done, created_at as createdAt FROM reminders WHERE member_id = ? ORDER BY trigger_at ASC`
      : `SELECT id, member_id as memberId, message, trigger_at as triggerAt, channel, done, created_at as createdAt FROM reminders ORDER BY trigger_at ASC`;
    const rows = memberId ? this.db.prepare(sql).all(memberId) : this.db.prepare(sql).all();
    return (rows as Array<Omit<Reminder, "done"> & { done: number }>).map((r) => ({ ...r, done: !!r.done }));
  }

  getPendingReminders(): Reminder[] {
    const rows = this.db
      .prepare(
        `SELECT id, member_id as memberId, message, trigger_at as triggerAt, channel, done, created_at as createdAt
         FROM reminders WHERE done = 0 ORDER BY trigger_at ASC`,
      )
      .all() as Array<Omit<Reminder, "done"> & { done: number }>;
    return rows.map((r) => ({ ...r, done: false }));
  }

  markReminderDone(id: string): void {
    this.db.prepare(`UPDATE reminders SET done = 1 WHERE id = ?`).run(id);
  }

  updateReminder(id: string, patch: { message?: string; triggerAt?: string; channel?: string }): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.message !== undefined) { fields.push("message = ?"); values.push(patch.message); }
    if (patch.triggerAt !== undefined) { fields.push("trigger_at = ?"); values.push(patch.triggerAt); }
    if (patch.channel !== undefined) { fields.push("channel = ?"); values.push(patch.channel); }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE reminders SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  deleteReminder(id: string): void {
    this.db.prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
  }

  logActionExecution(memberId: string, routineId: string, actionId: string, result: string, success: boolean, executedAt?: string): void {
    if (executedAt) {
      this.db.prepare(
        `INSERT INTO action_execution_log (member_id, routine_id, action_id, result, success, executed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(memberId, routineId, actionId, result, success ? 1 : 0, executedAt);
    } else {
      this.db.prepare(
        `INSERT INTO action_execution_log (member_id, routine_id, action_id, result, success) VALUES (?, ?, ?, ?, ?)`,
      ).run(memberId, routineId, actionId, result, success ? 1 : 0);
    }
  }

  wasActionExecutedAt(memberId: string, routineId: string, actionId: string, minuteKey: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM action_execution_log WHERE member_id = ? AND routine_id = ? AND action_id = ? AND executed_at LIKE ? LIMIT 1`,
    ).get(memberId, routineId, actionId, `${minuteKey}%`) as unknown;
    return !!row;
  }

  getActionExecutionLogs(memberId: string, limit = 20): Array<{
    id: number; memberId: string; routineId: string; actionId: string;
    result: string; success: boolean; executedAt: string;
  }> {
    const rows = this.db.prepare(
      `SELECT id, member_id, routine_id, action_id, result, success, executed_at
       FROM action_execution_log WHERE member_id = ? ORDER BY id DESC LIMIT ?`,
    ).all(memberId, limit) as Array<{
      id: number; member_id: string; routine_id: string; action_id: string;
      result: string; success: number; executed_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      memberId: r.member_id,
      routineId: r.routine_id,
      actionId: r.action_id,
      result: r.result,
      success: !!r.success,
      executedAt: r.executed_at,
    }));
  }

  getRecentActionExecutionLogs(limit = 100): Array<{
    id: number; memberId: string; routineId: string; actionId: string;
    result: string; success: boolean; executedAt: string;
  }> {
    const rows = this.db.prepare(
      `SELECT id, member_id, routine_id, action_id, result, success, executed_at
       FROM action_execution_log ORDER BY id DESC LIMIT ?`,
    ).all(limit) as Array<{
      id: number; member_id: string; routine_id: string; action_id: string;
      result: string; success: number; executed_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      memberId: r.member_id,
      routineId: r.routine_id,
      actionId: r.action_id,
      result: r.result,
      success: !!r.success,
      executedAt: r.executed_at,
    }));
  }

  cleanOldChats(daysToKeep = 30): number {
    const result = this.db
      .prepare(
        `DELETE FROM chat_history WHERE created_at < datetime('now', ?)`,
      )
      .run(`-${daysToKeep} days`);
    return result.changes;
  }

  getMemberLastMessageTimes(): { memberId: string; lastMessageTime: string }[] {
    return this.db
      .prepare(
        `SELECT member_id as memberId, MAX(created_at) as lastMessageTime
         FROM chat_history 
         WHERE role = 'user' 
         GROUP BY member_id`,
      )
      .all() as { memberId: string; lastMessageTime: string }[];
  }

  close(): void {
    this.db.close();
  }
}
