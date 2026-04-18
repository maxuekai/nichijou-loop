import { useEffect, useState } from "react";
import {
  ChevronDownIcon,
} from "@heroicons/react/24/outline";
import { createIconWrapper } from "../../components/ui/Icon";

// 创建包装过的图标组件
const ChevronIcon = createIconWrapper(ChevronDownIcon);

interface ConversationLog {
  id: number;
  memberId: string;
  memberName: string;
  userInput: string;
  finalReply: string;
  events: string;
  createdAt: string;
}

interface ParsedEvent {
  type: string;
  data: Record<string, unknown>;
}

export function LogsPage() {
  const [logs, setLogs] = useState<ConversationLog[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [filterMember, setFilterMember] = useState<string>("all");

  useEffect(() => {
    loadLogs();
    const interval = setInterval(loadLogs, 10000);
    return () => clearInterval(interval);
  }, []);

  async function loadLogs() {
    try {
      const res = await fetch("/api/logs");
      if (!res.ok) return;
      const data = await res.json() as { logs: ConversationLog[] };
      setLogs(data.logs ?? []);
    } catch { /* ignore */ }
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
        </div>
        <select
          value={filterMember}
          onChange={(e) => setFilterMember(e.target.value)}
          className="px-3 py-2 rounded-lg border border-stone-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20"
        >
          <option value="all">全部成员</option>
          {memberNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
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
                    </div>

                    {events.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-stone-500 mb-1">处理过程</p>
                        <div className="space-y-1.5">
                          {events.map((event, i) => (
                            <EventItem key={i} event={event} />
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
    </div>
  );
}

function EventItem({ event }: { event: ParsedEvent }) {
  const data = event.data;

  switch (event.type) {
    case "tool_start":
      return (
        <div className="flex items-center gap-2 text-xs text-blue-600 bg-blue-50 px-3 py-1.5 rounded-md">
          <span className="font-medium">🔧 调用工具:</span>
          <span className="font-mono">{data.toolName as string}</span>
          {data.params && (
            <span className="text-blue-400 truncate max-w-[300px]">
              {typeof data.params === "string" ? data.params : JSON.stringify(data.params)}
            </span>
          )}
        </div>
      );
    case "tool_end":
      return (
        <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-md ${
          data.isError ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"
        }`}>
          <span className="font-medium">{data.isError ? "❌" : "✅"} 工具结果:</span>
          <span className="truncate max-w-[400px]">{data.result as string}</span>
        </div>
      );
    case "text_delta":
      return null;
    case "turn_end":
      return (
        <div className="text-xs text-stone-400 px-3 py-1">
          --- 轮次结束 ---
        </div>
      );
    default:
      return null;
  }
}
