import type { Database } from "../db/database.js";
import type { Gateway } from "../gateway/gateway.js";
import type { FamilyManager } from "../family/family-manager.js";

export class ActivityReminderScheduler {
  private db: Database;
  private gateway: Gateway;
  private familyManager: FamilyManager;
  private timer: NodeJS.Timeout | null = null;
  private sentReminders = new Set<string>(); // Track sent reminders to avoid duplicates

  constructor(db: Database, gateway: Gateway, familyManager: FamilyManager) {
    this.db = db;
    this.gateway = gateway;
    this.familyManager = familyManager;
  }

  start(): void {
    // Run immediately and then every hour
    this.checkAndSendReminders();
    this.timer = setInterval(() => {
      this.checkAndSendReminders();
    }, 60 * 60 * 1000); // 1 hour
    console.log("[ActivityReminder] 微信活跃提醒调度器已启动");
  }

  private async checkAndSendReminders(): Promise<void> {
    try {
      const members = this.familyManager.getMembers();
      const lastMessageTimes = this.db.getMemberLastMessageTimes();
      const lastMessageMap = new Map(
        lastMessageTimes.map(item => [item.memberId, item.lastMessageTime])
      );

      for (const member of members) {
        // Skip if member hasn't enabled wechat notifications or doesn't have wechat binding
        if (!member.wechatNotifyEnabled || !member.channelBindings.wechat) {
          continue;
        }

        const lastMessageTime = lastMessageMap.get(member.id);
        if (!lastMessageTime) {
          // Member has never sent a message, skip
          continue;
        }

        const lastMessageDate = new Date(lastMessageTime);
        const now = new Date();
        const hoursSinceLastMessage = (now.getTime() - lastMessageDate.getTime()) / (1000 * 60 * 60);

        // Check if it's been more than 23 hours since last message
        if (hoursSinceLastMessage >= 23) {
          const reminderKey = `${member.id}_${lastMessageDate.toISOString().split('T')[0]}`;
          
          // Check if we've already sent a reminder for this day
          if (!this.sentReminders.has(reminderKey)) {
            await this.sendActivityReminder(member.id);
            this.sentReminders.add(reminderKey);
          }
        }
      }

      // Clean up old reminder records (keep only last 7 days)
      this.cleanupOldReminderRecords();
    } catch (err) {
      console.error("[ActivityReminder] 检查活跃提醒时出错:", err);
    }
  }

  private async sendActivityReminder(memberId: string): Promise<void> {
    const message = "⏰ 提醒：为了保持微信通讯正常，请回复任意消息以保持连接活跃。";
    let success = true;
    let result = message;
    
    try {
      await this.gateway.sendToMember(memberId, message);
      console.log(`[ActivityReminder] 已向成员 ${memberId} 发送活跃提醒`);
    } catch (err) {
      success = false;
      result = err instanceof Error ? err.message : String(err);
      console.error(`[ActivityReminder] 向成员 ${memberId} 发送活跃提醒失败:`, err);
    } finally {
      // Log the activity reminder execution
      this.db.logActionExecution(
        memberId,
        "activity_reminder",
        "wechat_activity_reminder",
        result,
        success,
      );
    }
  }

  private cleanupOldReminderRecords(): void {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const cutoffDate = sevenDaysAgo.toISOString().split('T')[0];
    
    // Remove old reminder records
    const keysToRemove: string[] = [];
    for (const key of this.sentReminders) {
      const [, dateStr] = key.split('_');
      if (dateStr && dateStr < cutoffDate) {
        keysToRemove.push(key);
      }
    }
    
    for (const key of keysToRemove) {
      this.sentReminders.delete(key);
    }
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sentReminders.clear();
    console.log("[ActivityReminder] 微信活跃提醒调度器已停止");
  }
}