/** Core message types used across all packages */

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
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

/** Download lifecycle for persisted logs and pipeline consumers */
export type MediaDownloadStatus = "completed" | "failed" | "processing";

/** Enhanced media content with metadata */
export interface MediaContent {
  type: "image" | "voice" | "file" | "video";
  filePath: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
  duration?: number; // 语音/视频时长(秒)
  hash?: string; // 文件哈希，用于去重
  downloadedAt?: string; // 下载时间戳
  /** Set when tracking download/persist state; omitted for legacy in-flight payloads */
  downloadStatus?: MediaDownloadStatus;
}

/** Reference/reply message content */
export interface ReferenceContent {
  messageId: string;
  content: string;
  mediaContent?: MediaContent[];
  timestamp: number;
  authorId: string;
  authorName?: string;
}

/** Content parts for multimodal messages (OpenAI style) */
export type MessageContentPart = 
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
  | { type: 'audio'; audio: { format: string; data: string } };

/** Enhanced message with multimodal support */
export interface MultimodalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MessageContentPart[];
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
  media?: MediaContent[];
  references?: ReferenceContent[];
}

export type ConversationMessage = Message | MultimodalMessage;

/** Family & member types */

export interface Family {
  id: string;
  name: string;
  createdAt: string;
  avatar?: string;
  homeCity?: string;
  homeAdcode?: string;
}

export interface FamilyMember {
  id: string;
  familyId: string;
  name: string;
  aliases?: string[]; // 昵称/别名列表
  preferredName?: string; // 偏好称呼，如果未设置则使用 name
  channelBindings: Record<string, string>;
  primaryChannel: string;
  role: "admin" | "member";
  avatar?: string;
  wechatNotifyEnabled?: boolean;
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

export interface ReminderRule {
  offsetMinutes: number;
  message: string;
  channel: "wechat" | "dashboard" | "both";
}

export interface DaySchedule {
  date: string;
  memberId: string;
  items: DayScheduleItem[];
}

export interface DayScheduleItem {
  id: string;
  title: string;
  timeSlot?: string;
  time?: string;
  source: "routine" | "family_routine";
  routineId?: string;
  reminders: ReminderRule[];
}

/** Inbound/outbound message types for Gateway */

export interface InboundMessage {
  channel: string;
  memberId: string;
  text: string;
  media?: MediaItem[];
  mediaContent?: MediaContent[];
  references?: ReferenceContent[];
  contextToken?: string;
  timestamp?: number;
  messageId?: string;
}

export interface OutboundMessage {
  memberId: string;
  text: string;
  media?: MediaItem[];
  mediaContent?: MediaContent[];
  replyToMessageId?: string;
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

/** Multimedia configuration types */

export interface MultimediaConfig {
  providers: {
    image: 'claude' | 'openai' | 'auto';
    voice: 'openai' | 'transcribe_only' | 'auto';
    mixed: 'openai' | 'claude' | 'auto';
  };
  voice_processing: {
    strategy: 'multimodal_native' | 'transcribe_only' | 'both_options';
    transcription_language: string;
  };
  storage: {
    base_path: string;
    cleanup_days: number;
    max_file_size_mb: number;
  };
  references: {
    max_thread_depth: number;
    include_media_in_context: boolean;
  };
}

/** Media processing result */
export interface MediaProcessingResult {
  success: boolean;
  content?: MediaContent;
  error?: string;
  transcription?: string; // 语音转录结果
  description?: string; // 图片描述
}

/** Thread context for reference messages */
export interface ThreadContext {
  threadId: string;
  messages: Array<{
    messageId: string;
    content: string;
    mediaContent?: MediaContent[];
    timestamp: number;
    authorId: string;
    authorName?: string;
    isReference?: boolean;
  }>;
  depth: number;
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

/** Conversation log row (admin dashboard / HTTP API shape) */
export interface ConversationLog {
  id: number;
  memberId: string;
  memberName: string;
  userInput: string;
  finalReply: string;
  events: string;
  createdAt: string;
}

/** Transcription / vision / thumbnail sidecar results tied to a log entry */
export interface ProcessedMediaInfo {
  mediaId: string;
  processType: "transcription" | "analysis" | "thumbnail";
  result: string;
  success: boolean;
  error?: string;
}

/** Conversation log with optional multimedia attachments and processing metadata */
export interface ConversationLogWithMedia extends ConversationLog {
  mediaContent?: MediaContent[];
  processedMedia?: ProcessedMediaInfo[];
}

/** Structured system runtime/error log row (admin dashboard / HTTP API shape) */
export type SystemLogKind = "runtime" | "error";

export type SystemLogLevel = "info" | "warn" | "error";

export interface SystemLogEntry {
  id: number;
  kind: SystemLogKind;
  level: SystemLogLevel;
  source: string;
  message: string;
  inputJson?: string;
  outputJson?: string;
  detailsJson?: string;
  errorJson?: string;
  durationMs?: number;
  traceId?: string;
  createdAt: string;
}
