import { useEffect, useState } from "react";
import {
  ChevronDownIcon,
  EyeIcon,
  TrashIcon,
  ClockIcon as HeroClockIcon,
} from "@heroicons/react/24/outline";
import type { ConversationLogWithMedia, MediaContent } from "@nichijou/shared";
import { createIconWrapper } from "../../components/ui/Icon";
import { MediaContentSection, ProcessedMediaInfo } from "../../components/multimedia";
import { api } from "../../api";

// 创建包装过的图标组件
const ChevronIcon = createIconWrapper(ChevronDownIcon);
const ViewIcon = createIconWrapper(EyeIcon);
const DeleteIcon = createIconWrapper(TrashIcon);
const ClockIcon = createIconWrapper(HeroClockIcon);

interface ParsedEvent {
  type: string;
  data: Record<string, unknown>;
}

export function LogsPage() {
  const [logs, setLogs] = useState<ConversationLogWithMedia[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [filterMember, setFilterMember] = useState<string>("all");
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set());
  const [showCleanupDialog, setShowCleanupDialog] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [expandedMediaLogs, setExpandedMediaLogs] = useState<Set<number>>(new Set());

  useEffect(() => {
    loadLogs();
    const interval = setInterval(loadLogs, 10000);
    return () => clearInterval(interval);
  }, []);

  async function loadLogs() {
    try {
      const res = await fetch("/api/logs");
      if (!res.ok) return;
      const data = await res.json() as { logs: ConversationLogWithMedia[] };
      setLogs(data.logs ?? []);
    } catch { /* ignore */ }
  }

  function toggleMediaExpansion(logId: number) {
    setExpandedMediaLogs((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(logId)) {
        newSet.delete(logId);
      } else {
        newSet.add(logId);
      }
      return newSet;
    });
  }

  function handleMediaPreview(media: MediaContent) {
    const mediaUrl = api.getMediaFile(media.filePath);
    window.open(mediaUrl, "_blank");
  }

  function toggleToolCallExpansion(logId: number, toolIndex: number) {
    const key = `${logId}-${toolIndex}`;
    setExpandedToolCalls(prev => {
      const newSet = new Set(prev);
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      return newSet;
    });
  }

  async function cleanupLogs(daysToKeep: number) {
    setCleanupLoading(true);
    try {
      const res = await fetch("/api/logs/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daysToKeep }),
      });
      
      if (res.ok) {
        const data = await res.json() as { deletedCount: number };
        alert(`成功清理了 ${data.deletedCount} 条日志记录`);
        await loadLogs();
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-stone-800">对话日志</h1>
          <p className="text-sm text-stone-500 mt-1">查看完整的对话过程，包括工具调用和思考过程</p>
          <p className="text-xs text-stone-400 mt-1 flex items-center gap-1">
            <ClockIcon size="sm" />
            日志自动保留90天，超期自动清理
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
          <select
            value={filterMember}
            onChange={(e) => setFilterMember(e.target.value)}
            className="px-3 py-2 rounded-lg border border-stone-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          >
            <option value="all">全部成员 ({logs.length})</option>
            {memberNames.map((name) => (
              <option key={name} value={name}>
                {name} ({logs.filter(l => l.memberName === name).length})
              </option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <p className="text-stone-400">暂无对话日志</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((log) => {
            const isExpanded = expandedId === log.id;
            const events = isExpanded ? parseEvents(log.events) : [];
            const toolCalls = events.filter((e) => e.type === "tool_start");
            return (
              <div key={log.id} className="bg-white rounded-xl border border-stone-200 overflow-hidden">
                <div
                  className="p-4 cursor-pointer hover:bg-stone-50/50 transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : log.id)}
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
                          onToggleExpand={() => toggleMediaExpansion(log.id)}
                          onPreviewMedia={handleMediaPreview}
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
                              onToggleExpand={() => toggleToolCallExpansion(log.id, i)}
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
      )}

      {/* 清理日志对话框 */}
      {showCleanupDialog && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => !cleanupLoading && setShowCleanupDialog(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-stone-800 mb-4">清理对话日志</h3>
            
            <div className="space-y-4">
              <p className="text-sm text-stone-600">
                选择要保留的日志天数，超过此期间的日志将被永久删除。
              </p>
              
              <div className="space-y-2">
                <div className="flex items-center justify-between p-3 rounded-lg border border-stone-200 hover:bg-stone-50 cursor-pointer" 
                     onClick={() => !cleanupLoading && cleanupLogs(30)}>
                  <div>
                    <p className="font-medium text-sm text-stone-800">保留最近30天</p>
                    <p className="text-xs text-stone-500">删除30天前的所有日志</p>
                  </div>
                  {cleanupLoading && <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />}
                </div>
                
                <div className="flex items-center justify-between p-3 rounded-lg border border-stone-200 hover:bg-stone-50 cursor-pointer"
                     onClick={() => !cleanupLoading && cleanupLogs(7)}>
                  <div>
                    <p className="font-medium text-sm text-stone-800">保留最近7天</p>
                    <p className="text-xs text-stone-500">删除7天前的所有日志</p>
                  </div>
                  {cleanupLoading && <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />}
                </div>
                
                <div className="flex items-center justify-between p-3 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 cursor-pointer"
                     onClick={() => !cleanupLoading && cleanupLogs(1)}>
                  <div>
                    <p className="font-medium text-sm text-red-800">保留最近1天</p>
                    <p className="text-xs text-red-600">删除1天前的所有日志（谨慎操作）</p>
                  </div>
                  {cleanupLoading && <div className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />}
                </div>
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
    case "tool_start":
      const paramsStr = data.params ? (typeof data.params === "string" ? data.params : JSON.stringify(data.params, null, 2)) : "";
      const hasParams = paramsStr && paramsStr.length > 0;
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
                <div className="px-3 py-2 bg-blue-25">
                  <p className="text-xs text-blue-500 font-mono truncate">
                    {paramsStr.slice(0, 100)}...
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      );
      
    case "tool_end":
      const resultStr = data.result as string || "";
      const isLongResult = resultStr.length > 200;
      const resultKey = `${logId}-${eventIndex}-result`;
      const isResultExpanded = isExpanded;
      
      return (
        <div className={`border rounded-md overflow-hidden ${
          data.isError 
            ? "bg-red-50 border-red-200" 
            : "bg-green-50 border-green-200"
        }`}>
          <div className={`flex items-center gap-2 text-xs px-3 py-1.5 ${
            data.isError ? "text-red-600" : "text-green-600"
          }`}>
            <span className="font-medium">{data.isError ? "❌" : "✅"} 工具结果:</span>
            {resultStr && (
              <button
                onClick={onToggleExpand}
                className={`ml-auto flex items-center gap-1 transition-colors ${
                  data.isError 
                    ? "text-red-500 hover:text-red-700" 
                    : "text-green-500 hover:text-green-700"
                }`}
              >
                <ViewIcon size="sm" />
                {isResultExpanded ? "收起结果" : "查看结果"}
                <ChevronIcon 
                  size="sm" 
                  className={`transition-transform ${isResultExpanded ? "rotate-180" : ""}`} 
                />
              </button>
            )}
          </div>
          
          {resultStr && (
            <div className={`border-t ${data.isError ? "border-red-200" : "border-green-200"}`}>
              {isResultExpanded || !isLongResult ? (
                <div className="px-3 py-2 bg-white">
                  <p className={`text-[10px] font-medium mb-1 ${
                    data.isError ? "text-red-600" : "text-green-600"
                  }`}>
                    结果详情:
                  </p>
                  <pre className={`text-xs whitespace-pre-wrap break-all font-mono p-2 rounded border ${
                    data.isError 
                      ? "text-red-800 bg-red-50 border-red-200" 
                      : "text-green-800 bg-green-50 border-green-200"
                  }`}>
                    {resultStr}
                  </pre>
                </div>
              ) : (
                <div className="px-3 py-2">
                  <p className={`text-xs font-mono truncate ${
                    data.isError ? "text-red-500" : "text-green-500"
                  }`}>
                    {resultStr.slice(0, 150)}...
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      );
      
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
