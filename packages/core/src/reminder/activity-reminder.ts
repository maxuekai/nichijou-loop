import type { Database } from "../db/database.js";
import type { Gateway } from "../gateway/gateway.js";
import type { FamilyManager } from "../family/family-manager.js";

export class ActivityReminderScheduler {
  private db: Database;
  private gateway: Gateway;
  private familyManager: FamilyManager;
  private timer: NodeJS.Timeout | null = null;

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
      const activityStates = this.db.getWechatActivityStates();
      const activityMap = new Map(
        activityStates.map((state) => [state.memberId, state])
      );

      for (const member of members) {
        // Skip if member hasn't enabled wechat notifications or doesn't have wechat binding
        if (!member.wechatNotifyEnabled || !member.channelBindings.wechat) {
          continue;
        }

        const activity = activityMap.get(member.id);
        const lastInboundAt = activity?.lastInboundAt ? Date.parse(activity.lastInboundAt) : NaN;
        if (!Number.isFinite(lastInboundAt)) {
          // Member has never sent a tracked WeChat message, skip
          continue;
        }

        const now = new Date();
        const hoursSinceLastInbound = (now.getTime() - lastInboundAt) / (1000 * 60 * 60);

        // Send at most one reminder attempt per inbound-message window.
        const lastReminderAttemptAt = activity?.lastReminderAttemptAt
          ? Date.parse(activity.lastReminderAttemptAt)
          : NaN;
        const hasReminderForCurrentWindow =
          Number.isFinite(lastReminderAttemptAt) && lastReminderAttemptAt > lastInboundAt;

        // Check if it's been more than 23 hours since last tracked inbound WeChat message.
        if (hoursSinceLastInbound >= 23 && !hasReminderForCurrentWindow) {
          const attemptAt = now.toISOString();
          this.db.markWechatActivityReminderAttempt(member.id, attemptAt);
          await this.sendActivityReminder(member.id);
        }
      }
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

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[ActivityReminder] 微信活跃提醒调度器已停止");
  }
}
