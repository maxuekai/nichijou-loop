import { useEffect, useState } from "react";
import {
  ChevronDownIcon,
  EyeIcon,
  TrashIcon,
  ClockIcon as HeroClockIcon,
} from "@heroicons/react/24/outline";
import type { ConversationLogWithMedia, MediaContent, SystemLogEntry } from "@nichijou/shared";
import { createIconWrapper } from "../../components/ui/Icon";
import { MediaContentSection, ProcessedMediaInfo } from "../../components/multimedia";
import { api } from "../../api";

const ChevronIcon = createIconWrapper(ChevronDownIcon);
const ViewIcon = createIconWrapper(EyeIcon);
const DeleteIcon = createIconWrapper(TrashIcon);
const ClockIcon = createIconWrapper(HeroClockIcon);

interface ParsedEvent {
  type: string;
  data: Record<string, unknown>;
}

type LogTab = "conversation" | "runtime" | "error";

const LOG_TABS: Array<{ id: LogTab; label: string; description: string }> = [
  { id: "conversation", label: "成员对话", description: "成员输入、回复、媒体和工具调用" },
  { id: "runtime", label: "运行日志", description: "系统流程、工具、调度和 API 记录" },
  { id: "error", label: "错误日志", description: "异常、失败结果和错误栈" },
];

export function LogsPage() {
  const [activeTab, setActiveTab] = useState<LogTab>("conversation");
  const [logs, setLogs] = useState<ConversationLogWithMedia[]>([]);
  const [systemLogs, setSystemLogs] = useState<SystemLogEntry[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedSystemId, setExpandedSystemId] = useState<number | null>(null);
  const [filterMember, setFilterMember] = useState<string>("all");
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set());
  const [showCleanupDialog, setShowCleanupDialog] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [expandedMediaLogs, setExpandedMediaLogs] = useState<Set<number>>(new Set());

  useEffect(() => {
    loadLogs(activeTab);
    const interval = setInterval(() => loadLogs(activeTab), 10000);
    return () => clearInterval(interval);
  }, [activeTab]);

  async function loadLogs(tab: LogTab = activeTab) {
    try {
      const res = await fetch(tab === "conversation" ? "/api/logs" : `/api/logs/system?kind=${tab}&limit=200`);
      if (!res.ok) return;
      if (tab === "conversation") {
        const data = await res.json() as { logs: ConversationLogWithMedia[] };
        setLogs(data.logs ?? []);
      } else {
        const data = await res.json() as { logs: SystemLogEntry[] };
        setSystemLogs(data.logs ?? []);
      }
    } catch {
      // 自动刷新失败不打断页面使用。
    }
  }

  function toggleMediaExpansion(logId: number) {
    setExpandedMediaLogs((prev) => {
      const next = new Set(prev);
      if (next.has(logId)) next.delete(logId);
      else next.add(logId);
      return next;
    });
  }

  function handleMediaPreview(media: MediaContent) {
    const mediaUrl = api.getMediaFile(media.filePath);
    window.open(mediaUrl, "_blank");
  }

  function toggleToolCallExpansion(logId: number, toolIndex: number) {
    const key = `${logId}-${toolIndex}`;
    setExpandedToolCalls((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function cleanupLogs(daysToKeep: number) {
    setCleanupLoading(true);
    try {
      const res = await fetch("/api/logs/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daysToKeep,
          target: activeTab === "conversation" ? "conversation" : activeTab,
        }),
      });

      if (res.ok) {
        const data = await res.json() as { deletedCount: number };
        alert(`成功清理了 ${data.deletedCount} 条日志记录`);
        await loadLogs(activeTab);
        setShowCleanupDialog(false);
      } else {
        alert("清理失败，请重试");
      }
    } catch (error) {
      console.error("清理日志失败:", error);
      alert("清理失败，请重试");
    } finally {
      setCleanupLoading(false);
    }
  }

  function parseEvents(eventsStr: string): ParsedEvent[] {
    try {
      return JSON.parse(eventsStr) as ParsedEvent[];
    } catch {
      return [];
    }
  }

  const memberNames = [...new Set(logs.map((l) => l.memberName))];
  const filtered = filterMember === "all" ? logs : logs.filter((l) => l.memberName === filterMember);
  const activeTabMeta = LOG_TABS.find((tab) => tab.id === activeTab)!;
  const currentTotal = activeTab === "conversation" ? logs.length : systemLogs.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-stone-800">日志</h1>
          <p className="text-sm text-stone-500 mt-1">{activeTabMeta.description}</p>
          <p className="text-xs text-stone-400 mt-1 flex items-center gap-1">
            <ClockIcon size="sm" />
            日志自动保留90天，每类最多保留10000条
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowCleanupDialog(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 transition-colors"
          >
            <DeleteIcon size="sm" />
            清理日志
          </button>
          {activeTab === "conversation" && (
            <select
              value={filterMember}
              onChange={(e) => setFilterMember(e.target.value)}
              className="px-3 py-2 rounded-lg border border-stone-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20"
            >
              <option value="all">全部成员 ({logs.length})</option>
              {memberNames.map((name) => (
                <option key={name} value={name}>
                  {name} ({logs.filter((l) => l.memberName === name).length})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="border-b border-stone-200">
        <div className="flex items-center gap-2">
          {LOG_TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            const count = tab.id === "conversation" ? logs.length : isActive ? systemLogs.length : undefined;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id);
                  setExpandedId(null);
                  setExpandedSystemId(null);
                }}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  isActive
                    ? "border-amber-500 text-amber-700"
                    : "border-transparent text-stone-500 hover:text-stone-800"
                }`}
              >
                {tab.label}{count !== undefined ? ` (${count})` : ""}
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === "conversation" ? (
        <ConversationLogList
          logs={filtered}
          expandedId={expandedId}
          expandedMediaLogs={expandedMediaLogs}
          expandedToolCalls={expandedToolCalls}
          onToggleLog={setExpandedId}
          onToggleMedia={toggleMediaExpansion}
          onToggleToolCall={toggleToolCallExpansion}
          onMediaPreview={handleMediaPreview}
          parseEvents={parseEvents}
        />
      ) : (
        <SystemLogList
          logs={systemLogs}
          expandedId={expandedSystemId}
          onToggleLog={setExpandedSystemId}
        />
      )}

      {showCleanupDialog && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => !cleanupLoading && setShowCleanupDialog(false)}
        >
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-stone-800 mb-4">清理{activeTabMeta.label}日志</h3>

            <div className="space-y-4">
              <p className="text-sm text-stone-600">
                当前共 {currentTotal} 条记录。选择要保留的日志天数，超过此期间的日志将被永久删除，并继续应用每类最多10000条的数量上限。
              </p>

              <div className="space-y-2">
                <CleanupOption
                  title="保留最近30天"
                  description="删除30天前的所有日志"
                  loading={cleanupLoading}
                  onClick={() => cleanupLogs(30)}
                />
                <CleanupOption
                  title="保留最近7天"
                  description="删除7天前的所有日志"
                  loading={cleanupLoading}
                  onClick={() => cleanupLogs(7)}
                />
                <CleanupOption
                  title="保留最近1天"
                  description="删除1天前的所有日志（谨慎操作）"
                  loading={cleanupLoading}
                  danger
                  onClick={() => cleanupLogs(1)}
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowCleanupDialog(false)}
                disabled={cleanupLoading}
                className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 transition-colors disabled:opacity-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ConversationLogListProps {
  logs: ConversationLogWithMedia[];
  expandedId: number | null;
  expandedMediaLogs: Set<number>;
  expandedToolCalls: Set<string>;
  onToggleLog: (id: number | null) => void;
  onToggleMedia: (logId: number) => void;
  onToggleToolCall: (logId: number, toolIndex: number) => void;
  onMediaPreview: (media: MediaContent) => void;
  parseEvents: (eventsStr: string) => ParsedEvent[];
}

function ConversationLogList({
  logs,
  expandedId,
  expandedMediaLogs,
  expandedToolCalls,
  onToggleLog,
  onToggleMedia,
  onToggleToolCall,
  onMediaPreview,
  parseEvents,
}: ConversationLogListProps) {
  if (logs.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
        <p className="text-stone-400">暂无对话日志</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {logs.map((log) => {
        const isExpanded = expandedId === log.id;
        const events = isExpanded ? parseEvents(log.events) : [];
        const toolCalls = events.filter((e) => e.type === "tool_start");

        return (
          <div key={log.id} className="bg-white rounded-xl border border-stone-200 overflow-hidden">
            <div
              className="p-4 cursor-pointer hover:bg-stone-50/50 transition-colors"
              onClick={() => onToggleLog(isExpanded ? null : log.id)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 text-xs font-medium">
                      {log.memberName}
                    </span>
                    <span className="text-xs text-stone-400">
                      {new Date(log.createdAt).toLocaleString("zh-CN")}
                    </span>
                    {toolCalls.length > 0 && (
                      <span className="text-xs text-stone-400">
                        {toolCalls.length} 个工具调用
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-stone-600 mb-1">
                    <span className="font-medium text-stone-800">用户：</span>
                    {log.userInput.length > 80 ? log.userInput.slice(0, 80) + "..." : log.userInput}
                  </p>
                  <p className="text-sm text-stone-500">
                    <span className="font-medium text-stone-700">回复：</span>
                    {log.finalReply.length > 120 ? log.finalReply.slice(0, 120) + "..." : log.finalReply}
                  </p>
                </div>
                <ChevronIcon
                  size="lg"
                  className={`text-stone-400 transition-transform flex-shrink-0 mt-1 ${isExpanded ? "rotate-180" : ""}`}
                />
              </div>
            </div>

            {isExpanded && (
              <div className="border-t border-stone-100 bg-stone-50 p-4 space-y-3">
                <div>
                  <p className="text-xs font-medium text-stone-500 mb-1">用户输入</p>
                  <p className="text-sm text-stone-700 bg-white p-3 rounded-lg border border-stone-200 whitespace-pre-wrap">
                    {log.userInput}
                  </p>

                  {log.mediaContent && log.mediaContent.length > 0 && (
                    <MediaContentSection
                      mediaList={log.mediaContent}
                      logId={log.id}
                      isExpanded={expandedMediaLogs.has(log.id)}
                      onToggleExpand={() => onToggleMedia(log.id)}
                      onPreviewMedia={onMediaPreview}
                    />
                  )}

                  {log.processedMedia && log.processedMedia.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs font-medium text-stone-500 mb-1">处理结果</p>
                      <div className="space-y-1">
                        {log.processedMedia.map((processed, index) => (
                          <ProcessedMediaInfo
                            key={`${log.id}-processed-${index}`}
                            info={processed}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {events.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-stone-500 mb-1">处理过程</p>
                    <div className="space-y-1.5">
                      {events.map((event, i) => (
                        <EventItem
                          key={i}
                          event={event}
                          logId={log.id}
                          eventIndex={i}
                          isExpanded={expandedToolCalls.has(`${log.id}-${i}`)}
                          onToggleExpand={() => onToggleToolCall(log.id, i)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-xs font-medium text-stone-500 mb-1">最终回复</p>
                  <p className="text-sm text-stone-700 bg-white p-3 rounded-lg border border-stone-200 whitespace-pre-wrap">
                    {log.finalReply}
                  </p>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface SystemLogListProps {
  logs: SystemLogEntry[];
  expandedId: number | null;
  onToggleLog: (id: number | null) => void;
}

function SystemLogList({ logs, expandedId, onToggleLog }: SystemLogListProps) {
  if (logs.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
        <p className="text-stone-400">暂无系统日志</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {logs.map((log) => {
        const isExpanded = expandedId === log.id;

        return (
          <div key={log.id} className="bg-white rounded-xl border border-stone-200 overflow-hidden">
            <div
              className="p-4 cursor-pointer hover:bg-stone-50/50 transition-colors"
              onClick={() => onToggleLog(isExpanded ? null : log.id)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <LevelBadge level={log.level} />
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-stone-100 text-stone-700 text-xs font-medium">
                      {log.source}
                    </span>
                    <span className="text-xs text-stone-400">
                      {new Date(log.createdAt).toLocaleString("zh-CN")}
                    </span>
                    {log.durationMs !== undefined && log.durationMs !== null && (
                      <span className="text-xs text-stone-400">{log.durationMs}ms</span>
                    )}
                    {log.traceId && (
                      <span className="text-xs text-stone-400 font-mono truncate max-w-[220px]">
                        {log.traceId}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-stone-700 break-words">{log.message}</p>
                </div>
                <ChevronIcon
                  size="lg"
                  className={`text-stone-400 transition-transform flex-shrink-0 mt-1 ${isExpanded ? "rotate-180" : ""}`}
                />
              </div>
            </div>

            {isExpanded && (
              <div className="border-t border-stone-100 bg-stone-50 p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <MetaItem label="类型" value={log.kind === "runtime" ? "运行日志" : "错误日志"} />
                  <MetaItem label="级别" value={log.level} />
                  <MetaItem label="来源" value={log.source} />
                  <MetaItem label="Trace ID" value={log.traceId || "-"} />
                  <MetaItem label="时间" value={new Date(log.createdAt).toLocaleString("zh-CN")} />
                  <MetaItem label="耗时" value={log.durationMs !== undefined && log.durationMs !== null ? `${log.durationMs}ms` : "-"} />
                </div>
                <JsonBlock title="输入" raw={log.inputJson} />
                <JsonBlock title="输出" raw={log.outputJson} />
                <JsonBlock title="详情" raw={log.detailsJson} />
                <JsonBlock title="错误" raw={log.errorJson} tone="error" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CleanupOption({
  title,
  description,
  loading,
  danger = false,
  onClick,
}: {
  title: string;
  description: string;
  loading: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${
        danger
          ? "border-red-200 bg-red-50 hover:bg-red-100"
          : "border-stone-200 hover:bg-stone-50"
      }`}
      onClick={() => !loading && onClick()}
    >
      <div>
        <p className={`font-medium text-sm ${danger ? "text-red-800" : "text-stone-800"}`}>{title}</p>
        <p className={`text-xs ${danger ? "text-red-600" : "text-stone-500"}`}>{description}</p>
      </div>
      {loading && (
        <div className={`w-4 h-4 border-2 border-t-transparent rounded-full animate-spin ${
          danger ? "border-red-400" : "border-amber-400"
        }`} />
      )}
    </div>
  );
}

function LevelBadge({ level }: { level: SystemLogEntry["level"] }) {
  const styles = {
    info: "bg-blue-50 text-blue-700",
    warn: "bg-amber-50 text-amber-700",
    error: "bg-red-50 text-red-700",
  }[level];

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${styles}`}>
      {level.toUpperCase()}
    </span>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg p-3 min-w-0">
      <p className="text-xs font-medium text-stone-400 mb-1">{label}</p>
      <p className="text-sm text-stone-700 break-all">{value}</p>
    </div>
  );
}

function JsonBlock({ title, raw, tone = "default" }: { title: string; raw?: string; tone?: "default" | "error" }) {
  if (!raw) return null;
  const formatted = formatJson(raw);
  const colorClass = tone === "error"
    ? "text-red-800 bg-red-50 border-red-200"
    : "text-stone-700 bg-white border-stone-200";

  return (
    <div>
      <p className="text-xs font-medium text-stone-500 mb-1">{title}</p>
      <pre className={`text-xs whitespace-pre-wrap break-all font-mono p-3 rounded-lg border max-h-96 overflow-auto ${colorClass}`}>
        {formatted}
      </pre>
    </div>
  );
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

interface EventItemProps {
  event: ParsedEvent;
  logId: number;
  eventIndex: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

function EventItem({ event, logId, eventIndex, isExpanded, onToggleExpand }: EventItemProps) {
  const data = event.data;

  switch (event.type) {
    case "tool_start": {
      const paramsStr = data.params ? (typeof data.params === "string" ? data.params : JSON.stringify(data.params, null, 2)) : "";
      const hasParams = paramsStr.length > 0;
      const isLongParams = paramsStr.length > 100;

      return (
        <div className="bg-blue-50 border border-blue-200 rounded-md overflow-hidden">
          <div className="flex items-center gap-2 text-xs text-blue-600 px-3 py-1.5">
            <span className="font-medium">🔧 调用工具:</span>
            <span className="font-mono font-semibold">{data.toolName as string}</span>
            {hasParams && (
              <button
                onClick={onToggleExpand}
                className="ml-auto flex items-center gap-1 text-blue-500 hover:text-blue-700 transition-colors"
              >
                <ViewIcon size="sm" />
                {isExpanded ? "收起参数" : "查看参数"}
                <ChevronIcon
                  size="sm"
                  className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}
                />
              </button>
            )}
          </div>

          {hasParams && (
            <div className="border-t border-blue-200">
              {isExpanded || !isLongParams ? (
                <div className="px-3 py-2 bg-white">
                  <p className="text-[10px] font-medium text-blue-600 mb-1">参数详情:</p>
                  <pre className="text-xs text-blue-800 whitespace-pre-wrap break-all font-mono bg-blue-50 p-2 rounded border">
                    {paramsStr}
                  </pre>
                </div>
              ) : (
                <div className="px-3 py-2">
                  <p className="text-xs text-blue-500 font-mono truncate">
                    {paramsStr.slice(0, 100)}...
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    case "tool_end": {
      const resultStr = data.result as string || "";
      const isLongResult = resultStr.length > 200;
      const isError = Boolean(data.isError);

      return (
        <div className={`border rounded-md overflow-hidden ${
          isError ? "bg-red-50 border-red-200" : "bg-green-50 border-green-200"
        }`}>
          <div className={`flex items-center gap-2 text-xs px-3 py-1.5 ${
            isError ? "text-red-600" : "text-green-600"
          }`}>
            <span className="font-medium">{isError ? "❌" : "✅"} 工具结果:</span>
            {resultStr && (
              <button
                onClick={onToggleExpand}
                className={`ml-auto flex items-center gap-1 transition-colors ${
                  isError ? "text-red-500 hover:text-red-700" : "text-green-500 hover:text-green-700"
                }`}
              >
                <ViewIcon size="sm" />
                {isExpanded ? "收起结果" : "查看结果"}
                <ChevronIcon
                  size="sm"
                  className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}
                />
              </button>
            )}
          </div>

          {resultStr && (
            <div className={`border-t ${isError ? "border-red-200" : "border-green-200"}`}>
              {isExpanded || !isLongResult ? (
                <div className="px-3 py-2 bg-white">
                  <p className={`text-[10px] font-medium mb-1 ${isError ? "text-red-600" : "text-green-600"}`}>
                    结果详情:
                  </p>
                  <pre className={`text-xs whitespace-pre-wrap break-all font-mono p-2 rounded border ${
                    isError
                      ? "text-red-800 bg-red-50 border-red-200"
                      : "text-green-800 bg-green-50 border-green-200"
                  }`}>
                    {resultStr}
                  </pre>
                </div>
              ) : (
                <div className="px-3 py-2">
                  <p className={`text-xs font-mono truncate ${isError ? "text-red-500" : "text-green-500"}`}>
                    {resultStr.slice(0, 150)}...
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    case "text_delta":
      return null;

    case "turn_end":
      return (
        <div className="text-xs text-stone-400 px-3 py-1 text-center border-t border-stone-200">
          --- 轮次结束 ---
        </div>
      );

    default:
      return null;
  }
}
