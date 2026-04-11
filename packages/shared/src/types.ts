/** Core message types used across all packages */

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface MediaItem {
  type: "image" | "video" | "file" | "voice";
  url?: string;
  path?: string;
  mimeType?: string;
  fileName?: string;
}

/** Family & member types */

export interface Family {
  id: string;
  name: string;
  createdAt: string;
  avatar?: string;
}

export interface FamilyMember {
  id: string;
  familyId: string;
  name: string;
  channelBindings: Record<string, string>;
  primaryChannel: string;
  role: "admin" | "member";
  avatar?: string;
}

/** Routine types */

export interface RoutineAction {
  id: string;
  type: "notify" | "plugin" | "ai_task";
  trigger: "before" | "at" | "after";
  offsetMinutes: number;
  channel?: "wechat" | "dashboard" | "both";
  message?: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  prompt?: string;
}

export interface Routine {
  id: string;
  title: string;
  description?: string;
  assigneeMemberIds?: string[];
  weekdays: number[];
  timeSlot?: "morning" | "afternoon" | "evening";
  time?: string;
  reminders: ReminderRule[];
  actions?: RoutineAction[];
  pluginId?: string;
  pluginConfig?: Record<string, unknown>;
  since?: string;
  archived?: boolean;
}

export interface Plan {
  id: string;
  date?: string;
  dateRange?: { start: string; end: string };
  action: "skip" | "add" | "modify";
  assigneeMemberIds?: string[];
  routineId?: string;
  title?: string;
  reason?: string;
  startTime?: string;
  time?: string;
  endTime?: string;
  timeSlot?: string;
  reminders?: ReminderRule[];
  actions?: RoutineAction[];
}
// Backward compatibility for existing code and payloads.
export type Override = Plan;

export interface ReminderRule {
  offsetMinutes: number;
  message: string;
  channel: "wechat" | "dashboard" | "both";
}

export interface DayPlan {
  date: string;
  memberId: string;
  items: DayPlanItem[];
}

export interface DayPlanItem {
  id: string;
  title: string;
  timeSlot?: string;
  time?: string;
  source: "routine" | "plan" | "family_routine" | "family_plan" | "override" | "family_override";
  routineId?: string;
  reminders: ReminderRule[];
}

/** Inbound/outbound message types for Gateway */

export interface InboundMessage {
  channel: string;
  memberId: string;
  text: string;
  media?: MediaItem[];
  contextToken?: string;
  timestamp?: number;
}

export interface OutboundMessage {
  memberId: string;
  text: string;
  media?: MediaItem[];
}

/** Reminder (独立提醒事项，持久化到 SQLite) */

export interface Reminder {
  id: string;
  memberId: string;
  message: string;
  triggerAt: string;
  channel: "wechat" | "dashboard" | "both";
  done: boolean;
  createdAt: string;
}

/** Channel status */

export interface ChannelStatus {
  connected: boolean;
  totalMembers?: number;
  connectedMembers?: number;
  expiredMembers?: string[];
  onlineSince?: string;
  lastError?: string;
}
