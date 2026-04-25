import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";
import {
  TrashIcon,
  PencilIcon,
  CogIcon,
  ChevronDownIcon,
  InformationCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { createIconWrapper } from "../../components/ui/Icon";
import {
  RoutineEditorDialog,
  defaultTimeForSlot,
  normalizeRoutineForScheduledActions,
  type Routine,
  type RoutineAction,
} from "./RoutineEditorDialog";

// 创建包装过的图标组件
const DeleteIcon = createIconWrapper(TrashIcon);
const EditIcon = createIconWrapper(PencilIcon);
const SettingsIcon = createIconWrapper(CogIcon);
const ChevronIcon = createIconWrapper(ChevronDownIcon);
const InfoIcon = createIconWrapper(InformationCircleIcon);
const WarningIcon = createIconWrapper(ExclamationTriangleIcon);

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

interface DayScheduleItem {
  id: string;
  title: string;
  timeSlot?: string;
  time?: string;
  source: string;
}

interface MemberDetail {
  member: { id: string; name: string; role: string; avatar?: string; channelBindings: Record<string, string>; wechatNotifyEnabled?: boolean };
  profile: string;
  routines: Routine[];
  daySchedule: { date: string; items: DayScheduleItem[] };
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function formatExecutedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function MembersPage() {
  const navigate = useNavigate();
  const [members, setMembers] = useState<Array<{ id: string; name: string; role: string; avatar?: string }>>([]);
  const [newName, setNewName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [tab, setTab] = useState<"schedule" | "routines" | "profile">("schedule");
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [contextCleared, setContextCleared] = useState(false);

  // Routine editing
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [deletingRoutine, setDeletingRoutine] = useState<string | null>(null);
  const [editingMemberInfo, setEditingMemberInfo] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"basic" | "notifications" | "advanced">("basic");
  const [memberNameDraft, setMemberNameDraft] = useState("");
  const [memberAvatarFile, setMemberAvatarFile] = useState<File | null>(null);
  const [memberAvatarPreview, setMemberAvatarPreview] = useState<string | null>(null);

  // Action execution logs
  const [actionLogs, setActionLogs] = useState<Array<{ id: number; routineId: string; actionId: string; result: string; success: boolean; executedAt: string }>>([]);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [triggeringRoutineId, setTriggeringRoutineId] = useState<string | null>(null);

  useEffect(() => {
    loadMembers();
  }, []);

  async function loadMembers() {
    try {
      setPageError(null);
      const data = await api.getFamily();
      setMembers(data.members);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "加载成员列表失败");
    }
  }

  async function addMember() {
    if (!newName.trim()) return;
    try {
      setPageError(null);
      await api.addMember(newName.trim());
      setNewName("");
      await loadMembers();
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "添加成员失败");
    }
  }

  async function refreshMemberDetail(id: string) {
    try {
      const res = await fetch(`/api/members/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as MemberDetail;
      setDetail(data);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "加载成员详情失败");
    }
  }

  async function selectMember(id: string) {
    setSelectedId(id);
    setTab("schedule");
    setLogsExpanded(false);
    setActionLogs([]);
    await refreshMemberDetail(id);
  }

  function startEditing() {
    setEditContent(detail?.profile ?? "");
    setEditing(true);
  }

  async function saveProfile() {
    if (!selectedId) return;
    setSaving(true);
    try {
      setPageError(null);
      await fetch(`/api/members/${selectedId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: editContent }),
      });
      setEditing(false);
      await refreshMemberDetail(selectedId);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "保存成员档案失败");
    }
    setSaving(false);
  }

  function openMemberEditDialog() {
    if (!detail) return;
    setMemberNameDraft(detail.member.name);
    setMemberAvatarFile(null);
    setMemberAvatarPreview(detail.member.avatar ? api.avatarUrl(detail.member.avatar) : null);
    setSettingsTab("basic");
    setEditingMemberInfo(true);
  }

  async function saveMemberInfo() {
    if (!selectedId || !memberNameDraft.trim()) return;
    try {
      setPageError(null);
      if (memberAvatarFile) {
        await api.uploadAvatar(selectedId, memberAvatarFile);
      }
      await api.updateMember(selectedId, { name: memberNameDraft.trim() });
      await loadMembers();
      await refreshMemberDetail(selectedId);
      setEditingMemberInfo(false);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "保存成员信息失败");
    }
  }

  async function deleteMember(id: string) {
    try {
      setPageError(null);
      await fetch(`/api/members/${id}`, { method: "DELETE" });
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
      await loadMembers();
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "删除成员失败");
    }
    setDeleting(null);
  }

  async function saveRoutine(routine: Routine) {
    if (!selectedId) return;
    try {
      setPageError(null);
      const normalizedRoutine = normalizeRoutineForScheduledActions(routine);
      await fetch(`/api/routines/${selectedId}/${routine.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(normalizedRoutine),
      });
      setEditingRoutine(null);
      await refreshMemberDetail(selectedId);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "保存习惯失败");
    }
  }

  async function deleteRoutine(routineId: string) {
    if (!selectedId) return;
    try {
      setPageError(null);
      await fetch(`/api/routines/${selectedId}/${routineId}`, { method: "DELETE" });
      setDeletingRoutine(null);
      await refreshMemberDetail(selectedId);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "删除习惯失败");
    }
  }

  async function triggerRoutineNow(routineId: string) {
    if (!selectedId) return;
    setTriggeringRoutineId(routineId);
    try {
      setPageError(null);
      const res = await api.triggerRoutine(selectedId, routineId);
      if (!res.ok) {
        setPageError(res.error ?? "立即触发失败");
        return;
      }
      setLogsExpanded(true);
      await loadActionLogs();
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "立即触发失败");
    } finally {
      setTriggeringRoutineId(null);
    }
  }

  async function loadActionLogs() {
    if (!selectedId) return;
    try {
      const logs = await api.getActionLogs(selectedId);
      setActionLogs(logs);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "加载执行日志失败");
    }
  }


  useEffect(() => {
    setActionLogs([]);
    if (logsExpanded && selectedId) {
      void loadActionLogs();
    }
  }, [selectedId]);

  function formatTimeSlot(slot?: string): string {
    if (!slot) return "";
    const labels: Record<string, string> = { morning: "上午", afternoon: "下午", evening: "晚上" };
    return labels[slot] ?? slot;
  }

  function formatActionTrigger(action: RoutineAction): string {
    if (action.offsetMinutes === 0) return "到时";
    if (action.trigger === "before") return `提前${action.offsetMinutes}分`;
    if (action.trigger === "after") return `延后${action.offsetMinutes}分`;
    return "到时";
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-stone-800">家庭成员</h1>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addMember()}
            placeholder="新成员名字"
            className="px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
          />
          <button
            onClick={addMember}
            className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
          >
            添加
          </button>
        </div>
      </div>
      {pageError && <p className="text-sm text-red-600">{pageError}</p>}

      {members.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 text-center">
          <p className="text-sm text-amber-800 font-medium">暂无成员</p>
          <p className="text-sm text-amber-600 mt-1">添加的第一个成员将自动成为管理员</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Member list */}
        <div className="space-y-2">
          {members.map((m) => (
            <div
              key={m.id}
              className={`relative group w-full text-left p-4 rounded-xl border transition-colors cursor-pointer ${
                selectedId === m.id
                  ? "border-amber-500 bg-amber-50"
                  : "border-stone-200 bg-white hover:border-stone-300"
              }`}
              onClick={() => selectMember(m.id)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {m.avatar ? (
                    <img src={api.avatarUrl(m.avatar)} alt={m.name} className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 font-medium">
                      {m.name.charAt(0)}
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-medium text-stone-800">{m.name}</p>
                    <p className="text-xs text-stone-400">{m.role === "admin" ? "管理员" : "成员"}</p>
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); setDeleting(m.id); }}
                  className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-stone-400 hover:text-red-500 hover:bg-red-50 transition-all"
                  title="删除成员"
                >
                  <DeleteIcon size="md" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Detail panel */}
        {selectedId && detail && (
          <div className="md:col-span-2 space-y-4">
            {/* Member header with avatar */}
            <div className="flex items-center justify-between gap-4 bg-white rounded-xl border border-stone-200 p-4">
              <div className="flex items-center gap-4 min-w-0">
                <div>
                  {detail.member.avatar ? (
                    <img src={api.avatarUrl(detail.member.avatar)} alt={detail.member.name} className="w-16 h-16 rounded-full object-cover" />
                  ) : (
                    <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 text-xl font-medium">
                      {detail.member.name.charAt(0)}
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-base font-semibold text-stone-800 truncate">{detail.member.name}</p>
                  <p className="text-xs text-stone-400 truncate">{detail.member.role === "admin" ? "管理员" : "成员"} · {detail.member.id}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={openMemberEditDialog}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-stone-700 bg-stone-100 hover:bg-stone-200 transition-colors"
                >
                  <SettingsIcon size="sm" />
                  设置
                </button>
              </div>
            </div>
            {/* Tabs */}
            <div className="flex gap-1 bg-stone-100 rounded-lg p-1">
              {([
                ["schedule", "今日安排"],
                ["routines", "7 days"],
                ["profile", "成员档案"],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
                    tab === key ? "bg-white text-stone-800 shadow-sm" : "text-stone-500 hover:text-stone-700"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Today's schedule */}
            {tab === "schedule" && (
              <div className="bg-white rounded-xl border border-stone-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-medium text-stone-500">
                    今日安排 · {detail.daySchedule.date}
                  </h3>
                  <span className="text-xs text-stone-400">{detail.daySchedule.items.length} 项</span>
                </div>

                {detail.daySchedule.items.length === 0 ? (
                  <p className="text-sm text-stone-400 py-6 text-center">今日无安排</p>
                ) : (
                  <div className="space-y-3">
                    {detail.daySchedule.items.map((item) => (
                      <div key={item.id} className="flex items-start gap-3 p-3 rounded-lg bg-stone-50">
                        <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                          item.source === "routine" ? "bg-amber-400" : "bg-indigo-400"
                        }`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-stone-800">{item.title}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {item.time && (
                              <span className="text-xs text-stone-500">{item.time}</span>
                            )}
                            {item.timeSlot && (
                              <span className="text-xs text-stone-400">{formatTimeSlot(item.timeSlot)}</span>
                            )}
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              item.source === "routine" ? "bg-amber-50 text-amber-600" : "bg-indigo-50 text-indigo-600"
                            }`}>
                              {item.source === "family_routine" ? "家庭习惯" : "个人习惯"}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 7 days */}
            {tab === "routines" && (
              <div className="space-y-4">
                <div className="bg-white rounded-xl border border-stone-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-medium text-stone-500">
                      7 days · {detail.routines.length} 项习惯
                    </h3>
                    <button
                      onClick={() => {
                        const newRoutine: Routine = {
                          id: `rtn_${Date.now().toString(36)}`,
                          title: "新习惯",
                          description: "新习惯",
                          weekdays: [0, 1, 2, 3, 4, 5, 6],
                          time: "09:00",
                          reminders: [],
                          actions: [],
                        };
                        setEditingRoutine(normalizeRoutineForScheduledActions(newRoutine, { seedAiTaskFromFallback: true }));
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors cursor-pointer"
                    >
                      + 新增习惯
                    </button>
                  </div>

                  {detail.routines.length === 0 ? (
                    <div className="py-6 text-center space-y-3">
                      <p className="text-sm text-stone-400">暂无习惯</p>
                      <p className="text-xs text-stone-400">
                        点击「+ 新增习惯」创建定时 AI 任务
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {detail.routines.map((routine) => (
                        <div key={routine.id} className="p-4 rounded-lg border border-stone-100 bg-stone-50 group">
                          <div className="flex items-start justify-between">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-stone-800">{routine.title}</p>
                              <div className="flex items-center gap-3 mt-1.5">
                                <div className="flex gap-1">
                                  {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                                    <span
                                      key={d}
                                      className={`w-6 h-6 rounded-full text-xs flex items-center justify-center ${
                                        routine.weekdays.includes(d)
                                          ? "bg-amber-500 text-white font-medium"
                                          : "bg-stone-200 text-stone-400"
                                      }`}
                                    >
                                      {WEEKDAY_NAMES[d]}
                                    </span>
                                  ))}
                                </div>
                                {routine.time && (
                                  <span className="text-xs text-stone-500">{routine.time}</span>
                                )}
                                {routine.timeSlot && (
                                  <span className="text-xs text-stone-400">{formatTimeSlot(routine.timeSlot)}</span>
                                )}
                                {routine.assigneeMemberIds && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">
                                    家庭习惯
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => { void triggerRoutineNow(routine.id); }}
                                disabled={triggeringRoutineId === routine.id}
                                className="px-2 py-1 rounded-md text-xs text-emerald-600 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 transition-colors"
                                title="立即触发测试"
                              >
                                {triggeringRoutineId === routine.id ? "触发中…" : "立即触发"}
                              </button>
                              <button
                                onClick={() => {
                                  if (routine.assigneeMemberIds) {
                                    navigate("/admin/family");
                                    return;
                                  }
                                  setEditingRoutine(normalizeRoutineForScheduledActions({
                                    ...routine,
                                    title: asText(routine.title),
                                    description: asText(routine.description),
                                    time: routine.time ?? defaultTimeForSlot(routine.timeSlot) ?? "09:00",
                                  }));
                                }}
                                className="p-1.5 rounded-md text-stone-400 hover:text-amber-600 hover:bg-amber-50 transition-colors cursor-pointer"
                                title="编辑"
                              >
                                <EditIcon size="md" />
                              </button>
                              <button
                                onClick={() => {
                                  if (!routine.assigneeMemberIds) setDeletingRoutine(routine.id);
                                }}
                                className="p-1.5 rounded-md text-stone-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                                title={routine.assigneeMemberIds ? "请在家庭页面删除" : "删除"}
                              >
                                <DeleteIcon size="md" />
                              </button>
                            </div>
                          </div>

                          {((routine.actions ?? []).length > 0 || (routine.reminders ?? []).length > 0) && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {(routine.actions ?? []).map((a) => {
                                const icons: Record<string, string> = { notify: "🔔", plugin: "🔧", ai_task: "🤖" };
                                const labels: Record<string, string> = { notify: "通知", plugin: "插件", ai_task: "AI" };
                                const colors: Record<string, string> = {
                                  notify: "bg-blue-50 text-blue-600",
                                  plugin: "bg-teal-50 text-teal-600",
                                  ai_task: "bg-purple-50 text-purple-600",
                                };
                                return (
                                  <span key={a.id} className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${colors[a.type] ?? "bg-stone-100 text-stone-600"}`}>
                                    {icons[a.type]} {formatActionTrigger(a)}
                                    {a.type === "notify" && a.message ? `: ${a.message}` : ""}
                                    {a.type === "plugin" && a.toolName ? `: ${a.toolName}` : ""}
                                    {a.type === "ai_task" ? `: ${labels[a.type]}` : ""}
                                  </span>
                                );
                              })}
                              {!(routine.actions?.length) && (routine.reminders ?? []).map((r, i) => (
                                <span key={i} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded">
                                  🔔 {r.offsetMinutes > 0 ? `提前${r.offsetMinutes}分钟` : "到时"}
                                  {r.message ? `: ${r.message}` : ""}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Action execution logs */}
                <div className="bg-white rounded-xl border border-stone-200 p-6">
                  <button
                    onClick={() => {
                      if (!logsExpanded) loadActionLogs();
                      setLogsExpanded(!logsExpanded);
                    }}
                    className="flex items-center justify-between w-full text-left"
                  >
                    <h3 className="text-sm font-medium text-stone-500">最近执行记录</h3>
                    <ChevronIcon size="md" className={`text-stone-400 transition-transform ${logsExpanded ? "rotate-180" : ""}`} />
                  </button>
                  {logsExpanded && (
                    <div className="mt-3">
                      {actionLogs.length === 0 ? (
                        <p className="text-xs text-stone-400 py-4 text-center">暂无执行记录</p>
                      ) : (
                        <div className="space-y-1.5 max-h-64 overflow-auto">
                          {actionLogs.map((log) => {
                            const routine = detail?.routines.find((r) => r.id === log.routineId);
                            return (
                              <div key={log.id} className="flex items-start gap-2 p-2.5 rounded-lg bg-stone-50 text-xs">
                                <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${log.success ? "bg-green-400" : "bg-red-400"}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-stone-700">{routine?.title ?? log.routineId}</span>
                                    <span className="text-stone-400">{formatExecutedAt(log.executedAt)}</span>
                                  </div>
                                  <p className="text-stone-500 mt-0.5 line-clamp-2">{log.result}</p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Profile */}
            {tab === "profile" && (
              <div className="space-y-4">
                <div className="bg-white rounded-xl border border-stone-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-medium text-stone-500">成员档案</h3>
                    {!editing ? (
                      <button
                        onClick={startEditing}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-stone-500 hover:bg-stone-100 transition-colors"
                      >
                        编辑
                      </button>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => setEditing(false)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-stone-500 hover:bg-stone-100 transition-colors"
                        >
                          取消
                        </button>
                        <button
                          onClick={saveProfile}
                          disabled={saving}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-50 transition-colors"
                        >
                          {saving ? "保存中..." : "保存"}
                        </button>
                      </div>
                    )}
                  </div>

                  {editing ? (
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="w-full h-[500px] text-sm text-stone-700 font-mono leading-relaxed bg-stone-50 rounded-lg p-4 border border-stone-200 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 resize-none"
                      spellCheck={false}
                    />
                  ) : (
                    <pre className="text-sm text-stone-700 whitespace-pre-wrap font-mono leading-relaxed bg-stone-50 rounded-lg p-4 max-h-[600px] overflow-auto">
                      {detail.profile || "暂无档案，可手动编辑添加"}
                    </pre>
                  )}

                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Member settings dialog */}
      {editingMemberInfo && detail && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setEditingMemberInfo(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-stone-200">
              <h3 className="text-lg font-semibold text-stone-800 mb-4">成员设置</h3>
              {/* Tab navigation */}
              <div className="flex gap-1 bg-stone-100 rounded-lg p-1">
                {([
                  ["basic", "基本信息"],
                  ["notifications", "通知设置"],
                  ["advanced", "高级设置"],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setSettingsTab(key)}
                    className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                      settingsTab === key 
                        ? "bg-white text-stone-800 shadow-sm" 
                        : "text-stone-500 hover:text-stone-700"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)]">
              {/* Basic Info Tab */}
              {settingsTab === "basic" && (
                <div className="space-y-4">
                  <div className="flex justify-center">
                    <label className="relative cursor-pointer group">
                      {memberAvatarPreview ? (
                        <img src={memberAvatarPreview} alt={memberNameDraft} className="w-20 h-20 rounded-full object-cover" />
                      ) : (
                        <div className="w-20 h-20 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 text-2xl font-medium">
                          {memberNameDraft.charAt(0) || detail.member.name.charAt(0)}
                        </div>
                      )}
                      <div className="absolute inset-0 rounded-full bg-black/35 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs">
                        更换头像
                      </div>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          setMemberAvatarFile(file);
                          setMemberAvatarPreview(URL.createObjectURL(file));
                        }}
                      />
                    </label>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">成员名称</label>
                    <input
                      type="text"
                      value={memberNameDraft}
                      onChange={(e) => setMemberNameDraft(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">成员角色</label>
                    <div className="px-3 py-2 rounded-lg bg-stone-50 text-sm text-stone-600">
                      {detail.member.role === "admin" ? "管理员" : "成员"}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">成员ID</label>
                    <div className="px-3 py-2 rounded-lg bg-stone-50 text-sm text-stone-600 font-mono">
                      {detail.member.id}
                    </div>
                  </div>
                </div>
              )}

              {/* Notifications Tab */}
              {settingsTab === "notifications" && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-sm font-medium text-stone-800 mb-3">微信通知</h4>
                    
                    {detail.member.channelBindings.wechat ? (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between p-4 rounded-lg border border-stone-200 bg-stone-50">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h5 className="text-sm font-medium text-stone-800">活跃提醒</h5>
                              <button
                                onClick={async () => {
                                  if (!selectedId) return;
                                  try {
                                    const newValue = !detail.member.wechatNotifyEnabled;
                                    await api.updateMember(selectedId, { wechatNotifyEnabled: newValue });
                                    await refreshMemberDetail(selectedId);
                                  } catch (err) {
                                    setPageError(err instanceof Error ? err.message : "更新活跃提醒设置失败");
                                  }
                                }}
                                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                                  detail.member.wechatNotifyEnabled ? "bg-green-500" : "bg-stone-300"
                                } cursor-pointer`}
                              >
                                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                                  detail.member.wechatNotifyEnabled ? "translate-x-4" : "translate-x-0.5"
                                }`} />
                              </button>
                            </div>
                            <p className="text-xs text-stone-500 leading-relaxed">
                              由于微信限制，用户超过24小时未发消息后无法接收推送。开启此功能后，系统会在用户23小时未发消息时主动发送提醒，确保通讯正常。
                            </p>
                          </div>
                        </div>
                        
                        <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                          <div className="flex items-start gap-2">
                            <InfoIcon size="md" className="text-blue-600 mt-0.5 flex-shrink-0" />
                            <div className="text-xs text-blue-700">
                              <p className="font-medium mb-1">微信连接状态：已绑定</p>
                              <p>微信用户可以正常接收系统通知和提醒消息</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-4 rounded-lg border border-amber-200 bg-amber-50">
                        <div className="flex items-start gap-2">
                          <WarningIcon size="md" className="text-amber-600 mt-0.5 flex-shrink-0" />
                          <div className="text-xs text-amber-700">
                            <p className="font-medium mb-1">未绑定微信</p>
                            <p>该成员尚未绑定微信账号，无法接收微信通知</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Advanced Tab */}
              {settingsTab === "advanced" && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-sm font-medium text-stone-800 mb-3">对话管理</h4>
                    <div className="space-y-4">
                      <div className="p-4 rounded-lg border border-stone-200">
                        <div className="flex items-center justify-between mb-2">
                          <h5 className="text-sm font-medium text-stone-800">清除上下文</h5>
                          <button
                            onClick={() => {
                              if (!selectedId) return;
                              void api.clearMemberContext(selectedId).then(() => {
                                setPageError(null);
                                setContextCleared(true);
                                setTimeout(() => setContextCleared(false), 2000);
                              }).catch((err) => {
                                setPageError(err instanceof Error ? err.message : "清除上下文失败");
                              });
                            }}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 transition-colors"
                          >
                            {contextCleared ? "已清除" : "清除"}
                          </button>
                        </div>
                        <p className="text-xs text-stone-500">
                          清除该成员的对话历史和上下文缓存。这将重置AI的记忆，下次对话时将是全新的开始。
                        </p>
                      </div>
                      
                      <div className="p-3 rounded-lg bg-yellow-50 border border-yellow-200">
                        <div className="flex items-start gap-2">
                          <WarningIcon size="md" className="text-yellow-600 mt-0.5 flex-shrink-0" />
                          <div className="text-xs text-yellow-700">
                            <p className="font-medium mb-1">注意</p>
                            <p>清除上下文后，AI将不再记住之前的对话内容，但成员档案和习惯数据不会受影响。</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-stone-200 bg-stone-50 flex justify-end gap-3">
              <button
                onClick={() => setEditingMemberInfo(false)}
                className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-200 transition-colors"
              >
                关闭
              </button>
              {settingsTab === "basic" && (
                <button
                  onClick={saveMemberInfo}
                  disabled={!memberNameDraft.trim()}
                  className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
                >
                  保存基本信息
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete member confirmation dialog */}
      {deleting && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setDeleting(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-stone-800 mb-2">确认删除</h3>
            <p className="text-sm text-stone-500 mb-6">
              确定要删除成员「{members.find((m) => m.id === deleting)?.name}」吗？此操作不可撤销。
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleting(null)}
                className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => deleteMember(deleting)}
                className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete routine confirmation dialog */}
      {deletingRoutine && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setDeletingRoutine(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-stone-800 mb-2">删除习惯</h3>
            <p className="text-sm text-stone-500 mb-6">
              确定要删除这个 7 days 习惯吗？
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeletingRoutine(null)}
                className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => deleteRoutine(deletingRoutine)}
                className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {editingRoutine && (
        <RoutineEditorDialog
          routine={editingRoutine}
          title={detail?.routines.some((r) => r.id === editingRoutine.id) ? "编辑 7 days 习惯" : "新增 7 days 习惯"}
          onChange={setEditingRoutine}
          onCancel={() => setEditingRoutine(null)}
          onSave={saveRoutine}
        />
      )}

      </div>
  );
}
