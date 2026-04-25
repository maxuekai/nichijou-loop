import BetterSqlite3 from "better-sqlite3";
import type { StorageManager } from "../storage/storage.js";
import type {
  Reminder,
  ConversationLogWithMedia,
  MediaContent,
  ProcessedMediaInfo,
  SystemLogEntry,
  SystemLogKind,
  SystemLogLevel,
} from "@nichijou/shared";

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
    this.ensureMultimediaLogColumns();
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
        member_name TEXT,
        user_input TEXT NOT NULL,
        final_reply TEXT NOT NULL,
        events TEXT NOT NULL,
        media_content TEXT,
        processed_media TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_conv_log_member
        ON conversation_logs(member_id, created_at);

      CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        input_json TEXT,
        output_json TEXT,
        details_json TEXT,
        error_json TEXT,
        duration_ms INTEGER,
        trace_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_system_logs_kind_created
        ON system_logs(kind, created_at);
      CREATE INDEX IF NOT EXISTS idx_system_logs_level_created
        ON system_logs(level, created_at);
      CREATE INDEX IF NOT EXISTS idx_system_logs_trace
        ON system_logs(trace_id);

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

      CREATE TABLE IF NOT EXISTS session_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL UNIQUE,
        messages_json TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_session_member
        ON session_states(member_id, updated_at);

      -- 媒体文件表
      CREATE TABLE IF NOT EXISTS media_files (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        file_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        duration REAL, -- 语音/视频时长(秒)
        file_type TEXT NOT NULL, -- image, voice, video, file
        ref_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_media_hash
        ON media_files(hash);
      CREATE INDEX IF NOT EXISTS idx_media_type
        ON media_files(file_type, created_at);
      CREATE INDEX IF NOT EXISTS idx_media_message
        ON media_files(message_id);

      -- 消息引用关系表
      CREATE TABLE IF NOT EXISTS message_references (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        referenced_message_id TEXT NOT NULL,
        reference_type TEXT NOT NULL DEFAULT 'reply',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_ref_message
        ON message_references(message_id);
      CREATE INDEX IF NOT EXISTS idx_ref_referenced
        ON message_references(referenced_message_id);
    `);
  }

  /** 为已有库补齐对话日志的多媒体与展示名字段（幂等） */
  private ensureMultimediaLogColumns(): void {
    const columns = ["member_name", "media_content", "processed_media"] as const;
    for (const col of columns) {
      try {
        this.db.exec(`ALTER TABLE conversation_logs ADD COLUMN ${col} TEXT;`);
      } catch {
        // 列已存在或其他可忽略错误
      }
    }
  }

  private parseJsonColumn<T>(raw: string | null | undefined, label: string): T | undefined {
    if (raw == null || raw === "") return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      console.error(`[Database] 解析 ${label} JSON 失败`, error);
      return undefined;
    }
  }

  saveChat(memberId: string, role: string, content: string, toolCalls?: string, toolCallId?: string): void {
    this.db.prepare(
      `INSERT INTO chat_history (member_id, role, content, tool_calls, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(memberId, role, content, toolCalls ?? null, toolCallId ?? null, new Date().toISOString());
  }

  getRecentChats(memberId: string, limit = 50): ChatRecord[] {
    return this.db
      .prepare(
        `SELECT id, member_id as memberId, role, content, created_at as createdAt
         FROM chat_history WHERE member_id = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`,
      )
      .all(memberId, limit) as ChatRecord[];
  }

  /**
   * 根据日期范围获取聊天记录
   */
  getChatsByDateRange(memberId: string, startDate: string, endDate: string): ChatRecord[] {
    return this.db
      .prepare(
        `SELECT id, member_id as memberId, role, content, created_at as createdAt
         FROM chat_history 
         WHERE member_id = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?)
         ORDER BY datetime(created_at) ASC, id ASC`,
      )
      .all(memberId, startDate, endDate) as ChatRecord[];
  }

  saveSummary(memberId: string, summary: string, periodStart: string, periodEnd: string): void {
    this.db
      .prepare(
        `INSERT INTO memory_summaries (member_id, summary, period_start, period_end, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(memberId, summary, periodStart, periodEnd, new Date().toISOString());
  }

  getLatestSummary(memberId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT summary FROM memory_summaries WHERE member_id = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT 1`,
      )
      .get(memberId) as { summary: string } | undefined;
    return row?.summary ?? null;
  }

  /**
   * 获取最新的完整摘要信息
   */
  getLatestSummaryDetail(memberId: string): { summary: string; createdAt: string; periodEnd: string } | null {
    const row = this.db
      .prepare(
        `SELECT summary, created_at, period_end FROM memory_summaries WHERE member_id = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT 1`,
      )
      .get(memberId) as { summary: string; created_at: string; period_end: string } | undefined;
    
    if (!row) return null;
    
    return {
      summary: row.summary,
      createdAt: row.created_at,
      periodEnd: row.period_end,
    };
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

  /** 保存带媒体信息的对话日志 */
  saveConversationLogWithMedia(
    memberId: string,
    memberName: string,
    userInput: string,
    finalReply: string,
    events: string,
    mediaContent?: MediaContent[],
    processedMedia?: ProcessedMediaInfo[],
  ): number {
    let mediaJson: string | null = null;
    let processedJson: string | null = null;
    try {
      if (mediaContent !== undefined) mediaJson = JSON.stringify(mediaContent);
    } catch (error) {
      console.error("[Database] 序列化 mediaContent 失败", error);
    }
    try {
      if (processedMedia !== undefined) processedJson = JSON.stringify(processedMedia);
    } catch (error) {
      console.error("[Database] 序列化 processedMedia 失败", error);
    }

    const stmt = this.db.prepare(`
      INSERT INTO conversation_logs (
        member_id, member_name, user_input, final_reply, events,
        media_content, processed_media, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const result = stmt.run(
      memberId,
      memberName,
      userInput,
      finalReply,
      events,
      mediaJson,
      processedJson,
    );

    return Number(result.lastInsertRowid);
  }

  /** 获取带媒体信息的对话日志 */
  getConversationLogsWithMedia(limit = 50): ConversationLogWithMedia[] {
    const stmt = this.db.prepare(`
      SELECT
        id, member_id as memberId, member_name as memberName,
        user_input as userInput, final_reply as finalReply,
        events, created_at as createdAt,
        media_content as mediaContentJson, processed_media as processedMediaJson
      FROM conversation_logs
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as Array<{
      id: number;
      memberId: string;
      memberName: string | null;
      userInput: string;
      finalReply: string;
      events: string;
      createdAt: string;
      mediaContentJson: string | null;
      processedMediaJson: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      memberId: row.memberId,
      memberName: row.memberName ?? row.memberId,
      userInput: row.userInput,
      finalReply: row.finalReply,
      events: row.events,
      createdAt: row.createdAt,
      mediaContent: this.parseJsonColumn<MediaContent[]>(row.mediaContentJson, "media_content"),
      processedMedia: this.parseJsonColumn<ProcessedMediaInfo[]>(row.processedMediaJson, "processed_media"),
    }));
  }

  // --- System logs ---

  saveSystemLog(log: {
    kind: SystemLogKind;
    level: SystemLogLevel;
    source: string;
    message: string;
    inputJson?: string | null;
    outputJson?: string | null;
    detailsJson?: string | null;
    errorJson?: string | null;
    durationMs?: number | null;
    traceId?: string | null;
    createdAt?: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO system_logs (
        kind, level, source, message, input_json, output_json, details_json,
        error_json, duration_ms, trace_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.kind,
      log.level,
      log.source,
      log.message,
      log.inputJson ?? null,
      log.outputJson ?? null,
      log.detailsJson ?? null,
      log.errorJson ?? null,
      log.durationMs ?? null,
      log.traceId ?? null,
      log.createdAt ?? new Date().toISOString(),
    );

    return Number(result.lastInsertRowid);
  }

  getSystemLogs(kind: SystemLogKind, limit = 200): SystemLogEntry[] {
    const rows = this.db.prepare(`
      SELECT
        id, kind, level, source, message,
        input_json as inputJson,
        output_json as outputJson,
        details_json as detailsJson,
        error_json as errorJson,
        duration_ms as durationMs,
        trace_id as traceId,
        created_at as createdAt
      FROM system_logs
      WHERE kind = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `).all(kind, limit) as SystemLogEntry[];

    return rows;
  }

  cleanOldSystemLogs(kind: SystemLogKind | "all" = "all", daysToKeep: number = 90): number {
    const modifier = `-${daysToKeep} days`;
    const result = kind === "all"
      ? this.db.prepare(`
          DELETE FROM system_logs
          WHERE datetime(created_at) < datetime('now', ?)
        `).run(modifier)
      : this.db.prepare(`
          DELETE FROM system_logs
          WHERE kind = ? AND datetime(created_at) < datetime('now', ?)
        `).run(kind, modifier);

    if (result.changes > 0) {
      const label = kind === "all" ? "系统日志" : `${kind} 系统日志`;
      console.log(`[Database] 清理了 ${result.changes} 条过期${label}`);
    }

    return result.changes;
  }

  getSystemLogsToDeleteCount(kind: SystemLogKind | "all", daysToKeep: number): number {
    const modifier = `-${daysToKeep} days`;
    const result = kind === "all"
      ? this.db.prepare(`
          SELECT COUNT(*) as count
          FROM system_logs
          WHERE datetime(created_at) < datetime('now', ?)
        `).get(modifier) as { count: number }
      : this.db.prepare(`
          SELECT COUNT(*) as count
          FROM system_logs
          WHERE kind = ? AND datetime(created_at) < datetime('now', ?)
        `).get(kind, modifier) as { count: number };

    return result.count;
  }

  cleanExcessSystemLogs(kind: SystemLogKind, maxCount: number = 10000): number {
    const countResult = this.db.prepare(`
      SELECT COUNT(*) as count FROM system_logs WHERE kind = ?
    `).get(kind) as { count: number };

    if (countResult.count <= maxCount) {
      return 0;
    }

    const result = this.db.prepare(`
      DELETE FROM system_logs
      WHERE kind = ?
        AND id NOT IN (
          SELECT id FROM system_logs
          WHERE kind = ?
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT ?
        )
    `).run(kind, kind, maxCount);

    if (result.changes > 0) {
      console.log(`[Database] 清理了 ${result.changes} 条超量 ${kind} 系统日志（保留最新 ${maxCount} 条）`);
    }

    return result.changes;
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
        `DELETE FROM chat_history
         WHERE datetime(created_at) < datetime('now', ?)
           AND EXISTS (
             SELECT 1
             FROM memory_summaries
             WHERE memory_summaries.member_id = chat_history.member_id
               AND datetime(memory_summaries.period_end) >= datetime(chat_history.created_at)
           )`,
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

  /**
   * 保存会话状态到数据库
   */
  saveSessionState(memberId: string, messages: any[], systemPrompt: string): void {
    const messagesJson = JSON.stringify(messages);
    const now = new Date().toISOString();
    
    this.db.prepare(`
      INSERT OR REPLACE INTO session_states (member_id, messages_json, system_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(memberId, messagesJson, systemPrompt, now, now);
  }

  /**
   * 从数据库获取会话状态
   */
  getSessionState(memberId: string): { messages: any[]; systemPrompt: string; updatedAt: string } | null {
    const result = this.db.prepare(`
      SELECT messages_json, system_prompt, updated_at
      FROM session_states 
      WHERE member_id = ?
    `).get(memberId) as { messages_json: string; system_prompt: string; updated_at: string } | undefined;

    if (!result) {
      return null;
    }

    try {
      const messages = JSON.parse(result.messages_json);
      return {
        messages,
        systemPrompt: result.system_prompt,
        updatedAt: result.updated_at,
      };
    } catch (error) {
      console.error(`[Database] 解析会话状态失败，memberId: ${memberId}`, error);
      return null;
    }
  }

  /**
   * 删除会话状态
   */
  deleteSessionState(memberId: string): void {
    this.db.prepare(`DELETE FROM session_states WHERE member_id = ?`).run(memberId);
  }

  /**
   * 获取所有活跃的会话状态
   */
  getAllSessionStates(): { memberId: string; messages: any[]; systemPrompt: string; updatedAt: string }[] {
    const results = this.db.prepare(`
      SELECT member_id, messages_json, system_prompt, updated_at
      FROM session_states 
      ORDER BY datetime(updated_at) DESC
    `).all() as { member_id: string; messages_json: string; system_prompt: string; updated_at: string }[];

    const sessions: { memberId: string; messages: any[]; systemPrompt: string; updatedAt: string }[] = [];

    for (const result of results) {
      try {
        const messages = JSON.parse(result.messages_json);
        sessions.push({
          memberId: result.member_id,
          messages,
          systemPrompt: result.system_prompt,
          updatedAt: result.updated_at,
        });
      } catch (error) {
        console.error(`[Database] 解析会话状态失败，memberId: ${result.member_id}`, error);
      }
    }

    return sessions;
  }

  /**
   * 清理过期的会话状态（超过指定天数）
   */
  cleanOldSessionStates(daysToKeep: number = 7): void {
    const result = this.db.prepare(`
      DELETE FROM session_states 
      WHERE datetime(updated_at) < datetime('now', '-${daysToKeep} days')
    `).run();
    
    if (result.changes > 0) {
      console.log(`[Database] 清理了 ${result.changes} 个过期会话状态`);
    }
  }

  /**
   * 清理过期的对话日志
   */
  cleanOldConversationLogs(daysToKeep: number = 90): number {
    const result = this.db.prepare(`
      DELETE FROM conversation_logs 
      WHERE datetime(created_at) < datetime('now', '-${daysToKeep} days')
    `).run();
    
    if (result.changes > 0) {
      console.log(`[Database] 清理了 ${result.changes} 条过期对话日志`);
    }
    
    return result.changes;
  }

  /**
   * 获取将要被删除的对话日志数量（用于预览）
   */
  getConversationLogsToDeleteCount(daysToKeep: number): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM conversation_logs 
      WHERE datetime(created_at) < datetime('now', '-${daysToKeep} days')
    `).get() as { count: number };
    
    return result.count;
  }

  /**
   * 清理多余的对话日志，只保留最新的N条记录
   */
  cleanExcessConversationLogs(maxCount: number = 10000): number {
    // 首先查询当前总数
    const countResult = this.db.prepare(`SELECT COUNT(*) as count FROM conversation_logs`).get() as { count: number };
    
    if (countResult.count <= maxCount) {
      return 0; // 无需清理
    }
    
    // 删除超出数量限制的旧记录
    const result = this.db.prepare(`
      DELETE FROM conversation_logs 
      WHERE id NOT IN (
        SELECT id FROM conversation_logs 
        ORDER BY created_at DESC 
        LIMIT ?
      )
    `).run(maxCount);
    
    if (result.changes > 0) {
      console.log(`[Database] 清理了 ${result.changes} 条超量对话日志（保留最新 ${maxCount} 条）`);
    }
    
    return result.changes;
  }

  /**
   * 清理过期的token使用记录
   */
  cleanOldTokenUsage(daysToKeep: number = 60): void {
    const result = this.db.prepare(`
      DELETE FROM token_usage 
      WHERE datetime(created_at) < datetime('now', '-${daysToKeep} days')
    `).run();
    
    if (result.changes > 0) {
      console.log(`[Database] 清理了 ${result.changes} 条过期token使用记录`);
    }
  }

  /**
   * 清理过期的提醒日志
   */
  cleanOldReminderLogs(daysToKeep: number = 30): void {
    const result = this.db.prepare(`
      DELETE FROM reminder_logs 
      WHERE datetime(sent_at) < datetime('now', '-${daysToKeep} days')
    `).run();
    
    if (result.changes > 0) {
      console.log(`[Database] 清理了 ${result.changes} 条过期提醒日志`);
    }
  }

  /**
   * 清理过期的执行日志
   */
  cleanOldActionExecutionLogs(daysToKeep: number = 60): void {
    const result = this.db.prepare(`
      DELETE FROM action_execution_log 
      WHERE datetime(executed_at) < datetime('now', '-${daysToKeep} days')
    `).run();
    
    if (result.changes > 0) {
      console.log(`[Database] 清理了 ${result.changes} 条过期执行日志`);
    }
  }

  // --- 媒体文件管理 ---

  /**
   * 保存媒体文件记录
   */
  saveMediaFile(record: {
    id: string;
    messageId?: string;
    filePath: string;
    hash: string;
    originalName: string;
    mimeType: string;
    size: number;
    duration?: number;
    fileType: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO media_files 
      (id, message_id, file_path, hash, original_name, mime_type, size, duration, file_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.messageId || null,
      record.filePath,
      record.hash,
      record.originalName,
      record.mimeType,
      record.size,
      record.duration || null,
      record.fileType
    );
  }

  /**
   * 根据哈希查找媒体文件
   */
  getMediaFileByHash(hash: string): {
    id: string;
    messageId: string | null;
    filePath: string;
    hash: string;
    originalName: string;
    mimeType: string;
    size: number;
    duration: number | null;
    fileType: string;
    refCount: number;
    createdAt: string;
    accessedAt: string;
  } | null {
    return this.db.prepare(`
      SELECT id, message_id as messageId, file_path as filePath, hash, 
             original_name as originalName, mime_type as mimeType, 
             size, duration, file_type as fileType, ref_count as refCount,
             created_at as createdAt, accessed_at as accessedAt
      FROM media_files WHERE hash = ?
    `).get(hash) as any;
  }

  /**
   * 更新文件访问时间
   */
  updateMediaFileAccess(hash: string): void {
    this.db.prepare(`
      UPDATE media_files 
      SET accessed_at = datetime('now')
      WHERE hash = ?
    `).run(hash);
  }

  /**
   * 增加文件引用计数
   */
  incrementMediaRefCount(hash: string): void {
    this.db.prepare(`
      UPDATE media_files 
      SET ref_count = ref_count + 1, accessed_at = datetime('now')
      WHERE hash = ?
    `).run(hash);
  }

  /**
   * 减少文件引用计数
   */
  decrementMediaRefCount(hash: string): void {
    this.db.prepare(`
      UPDATE media_files 
      SET ref_count = MAX(0, ref_count - 1)
      WHERE hash = ?
    `).run(hash);
  }

  /**
   * 获取过期的媒体文件
   */
  getExpiredMediaFiles(daysBefore: number): Array<{
    id: string;
    filePath: string;
    hash: string;
    originalName: string;
    refCount: number;
  }> {
    return this.db.prepare(`
      SELECT id, file_path as filePath, hash, original_name as originalName, ref_count as refCount
      FROM media_files 
      WHERE datetime(accessed_at) < datetime('now', '-${daysBefore} days')
      AND ref_count <= 0
      ORDER BY accessed_at ASC
    `).all() as any;
  }

  /**
   * 删除媒体文件记录
   */
  deleteMediaFile(hash: string): void {
    this.db.prepare(`DELETE FROM media_files WHERE hash = ?`).run(hash);
  }

  /**
   * 获取媒体文件统计信息
   */
  getMediaStats(): {
    totalFiles: number;
    totalSize: number;
    imageCount: number;
    voiceCount: number;
    videoCount: number;
    fileCount: number;
  } {
    const result = this.db.prepare(`
      SELECT 
        COUNT(*) as totalFiles,
        SUM(size) as totalSize,
        SUM(CASE WHEN file_type = 'image' THEN 1 ELSE 0 END) as imageCount,
        SUM(CASE WHEN file_type = 'voice' THEN 1 ELSE 0 END) as voiceCount,
        SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) as videoCount,
        SUM(CASE WHEN file_type = 'file' THEN 1 ELSE 0 END) as fileCount
      FROM media_files
    `).get() as any;

    return {
      totalFiles: result.totalFiles || 0,
      totalSize: result.totalSize || 0,
      imageCount: result.imageCount || 0,
      voiceCount: result.voiceCount || 0,
      videoCount: result.videoCount || 0,
      fileCount: result.fileCount || 0,
    };
  }

  // --- 消息引用管理 ---

  /**
   * 保存消息引用关系
   */
  saveMessageReference(reference: {
    id: string;
    messageId: string;
    referencedMessageId: string;
    referenceType?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO message_references 
      (id, message_id, referenced_message_id, reference_type)
      VALUES (?, ?, ?, ?)
    `).run(
      reference.id,
      reference.messageId,
      reference.referencedMessageId,
      reference.referenceType || 'reply'
    );
  }

  /**
   * 获取消息的引用关系
   */
  getMessageReferences(messageId: string): Array<{
    id: string;
    messageId: string;
    referencedMessageId: string;
    referenceType: string;
    createdAt: string;
  }> {
    return this.db.prepare(`
      SELECT id, message_id as messageId, referenced_message_id as referencedMessageId,
             reference_type as referenceType, created_at as createdAt
      FROM message_references
      WHERE message_id = ?
      ORDER BY created_at ASC
    `).all(messageId) as any;
  }

  /**
   * 获取引用了某条消息的消息列表
   */
  getReferencesToMessage(referencedMessageId: string): Array<{
    id: string;
    messageId: string;
    referencedMessageId: string;
    referenceType: string;
    createdAt: string;
  }> {
    return this.db.prepare(`
      SELECT id, message_id as messageId, referenced_message_id as referencedMessageId,
             reference_type as referenceType, created_at as createdAt
      FROM message_references
      WHERE referenced_message_id = ?
      ORDER BY created_at ASC
    `).all(referencedMessageId) as any;
  }

  /**
   * 清理过期的媒体文件记录
   */
  cleanOldMediaFiles(daysBefore: number): number {
    const result = this.db.prepare(`
      DELETE FROM media_files 
      WHERE datetime(accessed_at) < datetime('now', '-${daysBefore} days')
      AND ref_count <= 0
    `).run();
    
    if (result.changes > 0) {
      console.log(`[Database] 清理了 ${result.changes} 条过期媒体文件记录`);
    }
    
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
