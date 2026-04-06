import { useEffect, useRef, useState } from "react";
import { api } from "../../api";

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

interface RoutineAction {
  id: string;
  type: "notify" | "plugin" | "ai_task";
  trigger: "before" | "at" | "after";
  offsetMinutes: number;
  channel?: string;
  message?: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  prompt?: string;
}

interface PluginToolInfo {
  pluginId: string;
  pluginName: string;
  toolName: string;
  description: string;
}

interface Routine {
  id: string;
  title: string;
  weekdays: number[];
  timeSlot?: string;
  time?: string;
  reminders: Array<{ offsetMinutes: number; message: string; channel: string }>;
  actions?: RoutineAction[];
}

interface Override {
  id: string;
  date?: string;
  dateRange?: { start: string; end: string };
  action: string;
  routineId?: string;
  title?: string;
  reason?: string;
  timeSlot?: string;
}

interface DayPlanItem {
  id: string;
  title: string;
  timeSlot?: string;
  time?: string;
  source: string;
}

interface MemberDetail {
  member: { id: string; name: string; role: string; channelBindings: Record<string, string> };
  profile: string;
  routines: Routine[];
  overrides: Override[];
  dayPlan: { date: string; items: DayPlanItem[] };
}

export function MembersPage() {
  const [members, setMembers] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [newName, setNewName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [tab, setTab] = useState<"profile" | "routines" | "plan">("plan");
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  // Interview chat state
  const [interviewing, setInterviewing] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Interview result preview
  const [interviewResult, setInterviewResult] = useState<{ profile: string; routines: Routine[] } | null>(null);
  const [selectedRoutineIdx, setSelectedRoutineIdx] = useState<Set<number>>(new Set());
  const [applyingResult, setApplyingResult] = useState(false);

  // Routine editing
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [deletingRoutine, setDeletingRoutine] = useState<string | null>(null);
  const [pluginTools, setPluginTools] = useState<PluginToolInfo[]>([]);

  // Generate routines from profile
  const [generating, setGenerating] = useState(false);
  const [generatedRoutines, setGeneratedRoutines] = useState<Routine[] | null>(null);
  const [selectedGenIdx, setSelectedGenIdx] = useState<Set<number>>(new Set());
  const [applyingGen, setApplyingGen] = useState(false);

  useEffect(() => {
    loadMembers();
    api.getPluginTools().then(setPluginTools).catch(() => {});
  }, []);

  async function loadMembers() {
    const data = await api.getFamily();
    setMembers(data.members);
  }

  async function addMember() {
    if (!newName.trim()) return;
    await api.addMember(newName.trim());
    setNewName("");
    loadMembers();
  }

  async function selectMember(id: string) {
    setSelectedId(id);
    setTab("plan");
    try {
      const res = await fetch(`/api/members/${id}`);
      const data = await res.json() as MemberDetail;
      setDetail(data);
    } catch { /* ignore */ }
  }

  function startEditing() {
    setEditContent(detail?.profile ?? "");
    setEditing(true);
  }

  async function saveProfile() {
    if (!selectedId) return;
    setSaving(true);
    try {
      await fetch(`/api/members/${selectedId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: editContent }),
      });
      setEditing(false);
      selectMember(selectedId);
    } catch { /* ignore */ }
    setSaving(false);
  }

  async function startInterview() {
    if (!selectedId) return;
    setChatMessages([]);
    setChatLoading(true);
    setInterviewing(true);
    setInterviewResult(null);
    try {
      const res = await fetch(`/api/members/${selectedId}/interview/start`, { method: "POST" });
      const data = await res.json() as { ok: boolean; reply: string; error?: string };
      if (data.ok) {
        setChatMessages([{ role: "assistant", content: data.reply }]);
      } else {
        setChatMessages([{ role: "assistant", content: `启动失败：${data.error ?? "未知错误"}` }]);
      }
    } catch {
      setChatMessages([{ role: "assistant", content: "启动失败，请检查 LLM 连接。" }]);
    }
    setChatLoading(false);
  }

  async function sendChatMessage() {
    if (!selectedId || !chatInput.trim() || chatLoading) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    setChatMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setChatLoading(true);
    try {
      const res = await fetch(`/api/members/${selectedId}/interview/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg }),
      });
      const data = await res.json() as { ok: boolean; reply: string; error?: string };
      if (data.ok) {
        setChatMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
      }
    } catch { /* ignore */ }
    setChatLoading(false);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }

  async function finishInterview() {
    if (!selectedId) return;
    setFinishing(true);
    try {
      const res = await fetch(`/api/members/${selectedId}/interview/finish`, { method: "POST" });
      const data = await res.json() as { ok: boolean; profile: string; routines: Routine[]; error?: string };
      if (data.ok) {
        setInterviewResult({ profile: data.profile, routines: data.routines });
        setSelectedRoutineIdx(new Set(data.routines.map((_, i) => i)));
      }
    } catch { /* ignore */ }
    setFinishing(false);
  }

  async function cancelInterview() {
    if (!selectedId) return;
    await fetch(`/api/members/${selectedId}/interview/cancel`, { method: "POST" });
    setInterviewing(false);
    setChatMessages([]);
    setInterviewResult(null);
  }

  function toggleRoutine(idx: number) {
    setSelectedRoutineIdx((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  async function applyInterviewResult() {
    if (!selectedId || !interviewResult) return;
    setApplyingResult(true);
    try {
      if (interviewResult.profile) {
        await fetch(`/api/members/${selectedId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: interviewResult.profile }),
        });
      }
      const selectedRoutines = interviewResult.routines.filter((_, i) => selectedRoutineIdx.has(i));
      if (selectedRoutines.length > 0) {
        await fetch(`/api/members/${selectedId}/apply-routines`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routines: selectedRoutines }),
        });
      }
      setInterviewing(false);
      setChatMessages([]);
      setInterviewResult(null);
      selectMember(selectedId);
    } catch { /* ignore */ }
    setApplyingResult(false);
  }

  async function deleteMember(id: string) {
    try {
      await fetch(`/api/members/${id}`, { method: "DELETE" });
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
      loadMembers();
    } catch { /* ignore */ }
    setDeleting(null);
  }

  async function saveRoutine(routine: Routine) {
    if (!selectedId) return;
    try {
      await fetch(`/api/routines/${selectedId}/${routine.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(routine),
      });
      setEditingRoutine(null);
      selectMember(selectedId);
    } catch { /* ignore */ }
  }

  async function deleteRoutine(routineId: string) {
    if (!selectedId) return;
    try {
      await fetch(`/api/routines/${selectedId}/${routineId}`, { method: "DELETE" });
      setDeletingRoutine(null);
      selectMember(selectedId);
    } catch { /* ignore */ }
  }

  async function generateFromProfile() {
    if (!selectedId) return;
    setGenerating(true);
    setGeneratedRoutines(null);
    try {
      const res = await fetch(`/api/members/${selectedId}/generate-routines`, { method: "POST" });
      const data = await res.json() as { ok: boolean; routines: Routine[]; error?: string };
      if (data.ok && data.routines.length > 0) {
        setGeneratedRoutines(data.routines);
        setSelectedGenIdx(new Set(data.routines.map((_, i) => i)));
      } else if (!data.ok) {
        alert(data.error ?? "生成失败");
      } else {
        alert("未从档案中识别出可重复的习惯");
      }
    } catch { alert("请求失败"); }
    setGenerating(false);
  }

  async function applyGeneratedRoutines() {
    if (!selectedId || !generatedRoutines) return;
    setApplyingGen(true);
    try {
      const selected = generatedRoutines.filter((_, i) => selectedGenIdx.has(i));
      if (selected.length > 0) {
        await fetch(`/api/members/${selectedId}/apply-routines`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routines: selected }),
        });
      }
      setGeneratedRoutines(null);
      selectMember(selectedId);
    } catch { /* ignore */ }
    setApplyingGen(false);
  }

  function formatWeekdays(weekdays: number[]): string {
    return weekdays.map((d) => `周${WEEKDAY_NAMES[d]}`).join("、");
  }

  function formatTimeSlot(slot?: string): string {
    if (!slot) return "";
    const labels: Record<string, string> = { morning: "上午", afternoon: "下午", evening: "晚上" };
    return labels[slot] ?? slot;
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
                  <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 font-medium">
                    {m.name.charAt(0)}
                  </div>
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
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Detail panel */}
        {selectedId && detail && (
          <div className="md:col-span-2 space-y-4">
            {/* Tabs */}
            <div className="flex gap-1 bg-stone-100 rounded-lg p-1">
              {([
                ["plan", "今日计划"],
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

            {/* Today's plan */}
            {tab === "plan" && (
              <div className="bg-white rounded-xl border border-stone-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-medium text-stone-500">
                    今日计划 · {detail.dayPlan.date}
                  </h3>
                  <span className="text-xs text-stone-400">{detail.dayPlan.items.length} 项</span>
                </div>

                {detail.dayPlan.items.length === 0 ? (
                  <p className="text-sm text-stone-400 py-6 text-center">今日无安排</p>
                ) : (
                  <div className="space-y-3">
                    {detail.dayPlan.items.map((item) => (
                      <div key={item.id} className="flex items-start gap-3 p-3 rounded-lg bg-stone-50">
                        <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                          item.source === "routine" ? "bg-amber-400" : "bg-blue-400"
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
                              item.source === "routine" ? "bg-amber-50 text-amber-600" : "bg-blue-50 text-blue-600"
                            }`}>
                              {item.source === "routine" ? "7days" : "临时"}
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
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setEditingRoutine({
                            id: `rtn_${Date.now().toString(36)}`,
                            title: "",
                            weekdays: [],
                            reminders: [],
                            actions: [],
                          });
                        }}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 transition-colors cursor-pointer"
                      >
                        + 新增习惯
                      </button>
                      <button
                        onClick={() => { setTab("profile"); startInterview(); }}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors cursor-pointer"
                      >
                        AI 引导填写
                      </button>
                    </div>
                  </div>

                  {detail.routines.length === 0 ? (
                    <div className="py-6 text-center space-y-3">
                      <p className="text-sm text-stone-400">暂无习惯</p>
                      <p className="text-xs text-stone-400">
                        新成员可通过微信扫码后自动引导填写，或点击上方「AI 引导填写」
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
                              </div>
                            </div>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => {
                                  const r = { ...routine };
                                  if (!r.actions?.length && r.reminders.length > 0) {
                                    r.actions = r.reminders.map((rem, i) => ({
                                      id: `act_migrated_${i}`,
                                      type: "notify" as const,
                                      trigger: "before" as const,
                                      offsetMinutes: rem.offsetMinutes,
                                      channel: rem.channel,
                                      message: rem.message,
                                    }));
                                  }
                                  setEditingRoutine(r);
                                }}
                                className="p-1.5 rounded-md text-stone-400 hover:text-amber-600 hover:bg-amber-50 transition-colors cursor-pointer"
                                title="编辑"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                              <button
                                onClick={() => setDeletingRoutine(routine.id)}
                                className="p-1.5 rounded-md text-stone-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                                title="删除"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          </div>

                          {((routine.actions ?? []).length > 0 || routine.reminders.length > 0) && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {(routine.actions ?? []).map((a) => {
                                const icons: Record<string, string> = { notify: "🔔", plugin: "🔧", ai_task: "🤖" };
                                const labels: Record<string, string> = { notify: "通知", plugin: "插件", ai_task: "AI" };
                                const trigLabels: Record<string, string> = { before: "提前", at: "到时", after: "延后" };
                                const colors: Record<string, string> = {
                                  notify: "bg-blue-50 text-blue-600",
                                  plugin: "bg-teal-50 text-teal-600",
                                  ai_task: "bg-purple-50 text-purple-600",
                                };
                                return (
                                  <span key={a.id} className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${colors[a.type] ?? "bg-stone-100 text-stone-600"}`}>
                                    {icons[a.type]} {trigLabels[a.trigger]}{a.trigger !== "at" ? `${a.offsetMinutes}分` : ""}
                                    {a.type === "notify" && a.message ? `: ${a.message}` : ""}
                                    {a.type === "plugin" && a.toolName ? `: ${a.toolName}` : ""}
                                    {a.type === "ai_task" ? `: ${labels[a.type]}` : ""}
                                  </span>
                                );
                              })}
                              {!(routine.actions?.length) && routine.reminders.map((r, i) => (
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

                {/* Overrides */}
                {detail.overrides.length > 0 && (
                  <div className="bg-white rounded-xl border border-stone-200 p-6">
                    <h3 className="text-sm font-medium text-stone-500 mb-4">
                      临时变动 · {detail.overrides.length} 项
                    </h3>
                    <div className="space-y-2">
                      {detail.overrides.map((ovr) => {
                        const actionLabels: Record<string, { text: string; color: string }> = {
                          skip: { text: "跳过", color: "bg-red-50 text-red-600" },
                          add: { text: "新增", color: "bg-green-50 text-green-600" },
                          modify: { text: "修改", color: "bg-blue-50 text-blue-600" },
                        };
                        const a = actionLabels[ovr.action] ?? { text: ovr.action, color: "bg-stone-100 text-stone-500" };
                        return (
                          <div key={ovr.id} className="flex items-center gap-3 p-3 rounded-lg bg-stone-50">
                            <span className={`text-xs px-2 py-0.5 rounded font-medium ${a.color}`}>{a.text}</span>
                            <div className="flex-1">
                              <p className="text-sm text-stone-700">{ovr.title ?? ovr.reason ?? ovr.routineId ?? "临时变动"}</p>
                              <p className="text-xs text-stone-400 mt-0.5">
                                {ovr.date ?? (ovr.dateRange ? `${ovr.dateRange.start} ~ ${ovr.dateRange.end}` : "")}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Profile */}
            {tab === "profile" && (
              <div className="space-y-4">
                {/* Interview chat UI */}
                {interviewing && !interviewResult && (
                  <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
                    <div className="flex items-center justify-between p-4 border-b border-stone-100 bg-amber-50/50">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                        <h3 className="text-sm font-medium text-stone-700">AI 引导填写</h3>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={cancelInterview}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-stone-500 hover:bg-stone-100 transition-colors"
                        >
                          取消
                        </button>
                        <button
                          onClick={finishInterview}
                          disabled={chatMessages.length < 4 || finishing}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-50 transition-colors"
                        >
                          {finishing ? "生成中..." : "完成并生成档案"}
                        </button>
                      </div>
                    </div>

                    <div className="h-[400px] overflow-auto p-4 space-y-3 bg-stone-50/50">
                      {chatMessages.map((msg, i) => (
                        <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                          <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                            msg.role === "user"
                              ? "bg-amber-500 text-white rounded-br-md"
                              : "bg-white text-stone-700 border border-stone-200 rounded-bl-md"
                          }`}>
                            {msg.content}
                          </div>
                        </div>
                      ))}
                      {chatLoading && (
                        <div className="flex justify-start">
                          <div className="bg-white text-stone-400 border border-stone-200 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm">
                            <span className="inline-flex gap-1">
                              <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                              <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                              <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                            </span>
                          </div>
                        </div>
                      )}
                      <div ref={chatEndRef} />
                    </div>

                    <div className="p-3 border-t border-stone-100 bg-white">
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendChatMessage()}
                          placeholder="输入你的回答..."
                          disabled={chatLoading}
                          className="flex-1 px-4 py-2.5 rounded-xl border border-stone-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 disabled:opacity-50"
                        />
                        <button
                          onClick={sendChatMessage}
                          disabled={!chatInput.trim() || chatLoading}
                          className="px-4 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
                        >
                          发送
                        </button>
                      </div>
                      <p className="text-xs text-stone-400 mt-2 text-center">
                        回答完所有问题后，点击上方「完成并生成档案」
                      </p>
                    </div>
                  </div>
                )}

                {/* Interview result preview */}
                {interviewResult && (
                  <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
                    <div className="p-4 border-b border-stone-100 bg-amber-50/50">
                      <h3 className="text-sm font-medium text-stone-700">AI 整理结果</h3>
                      <p className="text-xs text-stone-500 mt-0.5">请检查以下档案和 7 days 习惯，确认后保存</p>
                    </div>

                    <div className="p-5 space-y-5 max-h-[500px] overflow-auto">
                      <div>
                        <h4 className="text-xs font-medium text-stone-500 mb-2">成员档案</h4>
                        <pre className="text-sm text-stone-700 whitespace-pre-wrap font-mono leading-relaxed bg-stone-50 rounded-lg p-4 border border-stone-100">
                          {interviewResult.profile || "（未生成档案）"}
                        </pre>
                      </div>

                      {interviewResult.routines.length > 0 && (
                        <div>
                          <h4 className="text-xs font-medium text-stone-500 mb-2">
                            识别的 7 days 习惯 · {interviewResult.routines.length} 项
                          </h4>
                          <div className="space-y-2">
                            {interviewResult.routines.map((routine, idx) => (
                              <label
                                key={idx}
                                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                                  selectedRoutineIdx.has(idx)
                                    ? "border-amber-300 bg-amber-50/50"
                                    : "border-stone-200 bg-stone-50 opacity-60"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedRoutineIdx.has(idx)}
                                  onChange={() => toggleRoutine(idx)}
                                  className="mt-0.5 rounded border-stone-300 text-amber-500 focus:ring-amber-500/20"
                                />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-stone-800">{routine.title}</p>
                                  <div className="flex items-center gap-3 mt-1">
                                    <div className="flex gap-0.5">
                                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                                        <span key={d} className={`w-5 h-5 rounded-full text-[10px] flex items-center justify-center ${
                                          routine.weekdays.includes(d)
                                            ? "bg-amber-500 text-white font-medium"
                                            : "bg-stone-200 text-stone-400"
                                        }`}>{WEEKDAY_NAMES[d]}</span>
                                      ))}
                                    </div>
                                    {routine.time && <span className="text-xs text-stone-500">{routine.time}</span>}
                                    {routine.timeSlot && <span className="text-xs text-stone-400">{formatTimeSlot(routine.timeSlot)}</span>}
                                  </div>
                                </div>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="p-4 border-t border-stone-100 flex justify-between">
                      <button
                        onClick={() => { setInterviewResult(null); }}
                        className="px-4 py-2 rounded-lg text-sm text-stone-500 hover:bg-stone-100 transition-colors"
                      >
                        返回继续对话
                      </button>
                      <div className="flex gap-2">
                        <button
                          onClick={cancelInterview}
                          className="px-4 py-2 rounded-lg text-sm text-stone-500 hover:bg-stone-100 transition-colors"
                        >
                          放弃
                        </button>
                        <button
                          onClick={applyInterviewResult}
                          disabled={applyingResult}
                          className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
                        >
                          {applyingResult ? "保存中..." : "确认保存"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Normal profile view (when not interviewing) */}
                {!interviewing && (
                  <div className="space-y-4">
                    <div className="bg-white rounded-xl border border-stone-200 p-6">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-medium text-stone-500">成员档案</h3>
                        {!editing ? (
                          <div className="flex gap-2">
                            <button
                              onClick={startInterview}
                              className="px-3 py-1.5 rounded-lg text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors"
                            >
                              AI 引导填写
                            </button>
                            <button
                              onClick={startEditing}
                              className="px-3 py-1.5 rounded-lg text-xs font-medium text-stone-500 hover:bg-stone-100 transition-colors"
                            >
                              手动编辑
                            </button>
                          </div>
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
                          {detail.profile || "暂无档案，点击「AI 引导填写」让管家帮你完善"}
                        </pre>
                      )}

                      {/* Generate from profile button */}
                      {!editing && detail.profile && (
                        <div className="mt-4 pt-4 border-t border-stone-100">
                          <button
                            onClick={generateFromProfile}
                            disabled={generating}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 disabled:opacity-50 transition-colors"
                          >
                            {generating ? (
                              <>
                                <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                正在分析档案…
                              </>
                            ) : (
                              "从档案生成 7 days 习惯"
                            )}
                          </button>
                          <p className="text-xs text-stone-400 mt-1.5">
                            AI 将从档案内容中自动识别每周重复的生活习惯
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Generated routines preview */}
                    {generatedRoutines && (
                      <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
                        <div className="p-4 border-b border-amber-100 bg-amber-50/50">
                          <h3 className="text-sm font-medium text-stone-700">从档案识别的 7 days 习惯</h3>
                          <p className="text-xs text-stone-500 mt-0.5">选择需要添加的习惯，然后确认保存</p>
                        </div>
                        <div className="p-4 space-y-2">
                          {generatedRoutines.map((routine, idx) => (
                            <label
                              key={idx}
                              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                                selectedGenIdx.has(idx)
                                  ? "border-amber-300 bg-amber-50/50"
                                  : "border-stone-200 bg-stone-50 opacity-60"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={selectedGenIdx.has(idx)}
                                onChange={() => {
                                  setSelectedGenIdx((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(idx)) next.delete(idx); else next.add(idx);
                                    return next;
                                  });
                                }}
                                className="mt-0.5 rounded border-stone-300 text-amber-500 focus:ring-amber-500/20"
                              />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-stone-800">{routine.title}</p>
                                <div className="flex items-center gap-3 mt-1">
                                  <div className="flex gap-0.5">
                                    {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                                      <span key={d} className={`w-5 h-5 rounded-full text-[10px] flex items-center justify-center ${
                                        routine.weekdays.includes(d)
                                          ? "bg-amber-500 text-white font-medium"
                                          : "bg-stone-200 text-stone-400"
                                      }`}>{WEEKDAY_NAMES[d]}</span>
                                    ))}
                                  </div>
                                  {routine.time && <span className="text-xs text-stone-500">{routine.time}</span>}
                                  {routine.timeSlot && <span className="text-xs text-stone-400">{formatTimeSlot(routine.timeSlot)}</span>}
                                </div>
                              </div>
                            </label>
                          ))}
                        </div>
                        <div className="p-4 border-t border-amber-100 flex justify-end gap-2">
                          <button
                            onClick={() => setGeneratedRoutines(null)}
                            className="px-4 py-2 rounded-lg text-sm text-stone-500 hover:bg-stone-100 transition-colors"
                          >
                            取消
                          </button>
                          <button
                            onClick={applyGeneratedRoutines}
                            disabled={applyingGen || selectedGenIdx.size === 0}
                            className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
                          >
                            {applyingGen ? "保存中..." : `添加 ${selectedGenIdx.size} 项习惯`}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

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

      {/* Edit routine dialog */}
      {editingRoutine && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setEditingRoutine(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-stone-800 mb-4">
              {detail?.routines.some((r) => r.id === editingRoutine.id) ? "编辑 7 days 习惯" : "新增 7 days 习惯"}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">名称</label>
                <input
                  type="text"
                  value={editingRoutine.title}
                  onChange={(e) => setEditingRoutine({ ...editingRoutine, title: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-500 mb-2">每周重复</label>
                <div className="flex gap-2">
                  {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                    <button
                      key={d}
                      onClick={() => {
                        const wds = editingRoutine.weekdays.includes(d)
                          ? editingRoutine.weekdays.filter((x) => x !== d)
                          : [...editingRoutine.weekdays, d].sort();
                        setEditingRoutine({ ...editingRoutine, weekdays: wds });
                      }}
                      className={`w-9 h-9 rounded-full text-sm font-medium transition-colors ${
                        editingRoutine.weekdays.includes(d)
                          ? "bg-amber-500 text-white"
                          : "bg-stone-100 text-stone-400 hover:bg-stone-200"
                      }`}
                    >
                      {WEEKDAY_NAMES[d]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">时段</label>
                  <select
                    value={editingRoutine.timeSlot ?? ""}
                    onChange={(e) => setEditingRoutine({ ...editingRoutine, timeSlot: e.target.value || undefined })}
                    className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  >
                    <option value="">不指定</option>
                    <option value="morning">上午</option>
                    <option value="afternoon">下午</option>
                    <option value="evening">晚上</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">具体时间</label>
                  <input
                    type="time"
                    value={editingRoutine.time ?? ""}
                    onChange={(e) => setEditingRoutine({ ...editingRoutine, time: e.target.value || undefined })}
                    className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  />
                </div>
              </div>

              {/* Actions editor */}
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-2">自动化动作</label>
                <div className="space-y-2">
                  {(editingRoutine.actions ?? []).map((action, idx) => {
                    const typeLabels: Record<string, string> = { notify: "通知", plugin: "插件工具", ai_task: "AI 任务" };
                    const typeIcons: Record<string, string> = { notify: "🔔", plugin: "🔧", ai_task: "🤖" };
                    const triggerLabels: Record<string, string> = { before: "提前", at: "到时", after: "延后" };
                    return (
                      <div key={action.id} className="p-3 rounded-lg bg-stone-50 border border-stone-100 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-stone-600">
                            {typeIcons[action.type]} {typeLabels[action.type]}
                          </span>
                          <button
                            onClick={() => {
                              const actions = (editingRoutine.actions ?? []).filter((_, i) => i !== idx);
                              setEditingRoutine({ ...editingRoutine, actions });
                            }}
                            className="p-1 rounded text-stone-400 hover:text-red-500 hover:bg-red-50 transition-colors cursor-pointer"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            value={action.trigger}
                            onChange={(e) => {
                              const actions = [...(editingRoutine.actions ?? [])];
                              actions[idx] = { ...actions[idx]!, trigger: e.target.value as RoutineAction["trigger"] };
                              setEditingRoutine({ ...editingRoutine, actions });
                            }}
                            className="px-2 py-1 rounded border border-stone-300 text-xs focus:outline-none focus:ring-1 focus:ring-amber-500/20"
                          >
                            <option value="before">提前</option>
                            <option value="at">到时</option>
                            <option value="after">延后</option>
                          </select>
                          {action.trigger !== "at" && (
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min={0}
                                value={action.offsetMinutes}
                                onChange={(e) => {
                                  const actions = [...(editingRoutine.actions ?? [])];
                                  actions[idx] = { ...actions[idx]!, offsetMinutes: parseInt(e.target.value) || 0 };
                                  setEditingRoutine({ ...editingRoutine, actions });
                                }}
                                className="w-16 px-2 py-1 rounded border border-stone-300 text-xs text-center focus:outline-none focus:ring-1 focus:ring-amber-500/20"
                              />
                              <span className="text-xs text-stone-400">分钟</span>
                            </div>
                          )}
                          <select
                            value={action.channel ?? "wechat"}
                            onChange={(e) => {
                              const actions = [...(editingRoutine.actions ?? [])];
                              actions[idx] = { ...actions[idx]!, channel: e.target.value };
                              setEditingRoutine({ ...editingRoutine, actions });
                            }}
                            className="px-2 py-1 rounded border border-stone-300 text-xs focus:outline-none focus:ring-1 focus:ring-amber-500/20"
                          >
                            <option value="wechat">微信</option>
                            <option value="dashboard">面板</option>
                            <option value="both">两者</option>
                          </select>
                        </div>
                        {action.type === "notify" && (
                          <input
                            type="text"
                            value={action.message ?? ""}
                            onChange={(e) => {
                              const actions = [...(editingRoutine.actions ?? [])];
                              actions[idx] = { ...actions[idx]!, message: e.target.value };
                              setEditingRoutine({ ...editingRoutine, actions });
                            }}
                            placeholder="通知内容"
                            className="w-full px-2 py-1.5 rounded border border-stone-300 text-xs focus:outline-none focus:ring-1 focus:ring-amber-500/20"
                          />
                        )}
                        {action.type === "plugin" && (
                          <div className="space-y-1.5">
                            <select
                              value={action.toolName ?? ""}
                              onChange={(e) => {
                                const actions = [...(editingRoutine.actions ?? [])];
                                actions[idx] = { ...actions[idx]!, toolName: e.target.value };
                                setEditingRoutine({ ...editingRoutine, actions });
                              }}
                              className="w-full px-2 py-1.5 rounded border border-stone-300 text-xs focus:outline-none focus:ring-1 focus:ring-amber-500/20"
                            >
                              <option value="">选择工具...</option>
                              {pluginTools.map((t) => (
                                <option key={t.toolName} value={t.toolName}>
                                  [{t.pluginName}] {t.toolName}
                                </option>
                              ))}
                            </select>
                            <textarea
                              value={action.toolParams ? JSON.stringify(action.toolParams, null, 2) : "{}"}
                              onChange={(e) => {
                                const actions = [...(editingRoutine.actions ?? [])];
                                try {
                                  actions[idx] = { ...actions[idx]!, toolParams: JSON.parse(e.target.value) };
                                } catch {
                                  return;
                                }
                                setEditingRoutine({ ...editingRoutine, actions });
                              }}
                              placeholder='{"key": "value"}'
                              rows={2}
                              className="w-full px-2 py-1.5 rounded border border-stone-300 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/20 resize-none"
                            />
                          </div>
                        )}
                        {action.type === "ai_task" && (
                          <textarea
                            value={action.prompt ?? ""}
                            onChange={(e) => {
                              const actions = [...(editingRoutine.actions ?? [])];
                              actions[idx] = { ...actions[idx]!, prompt: e.target.value };
                              setEditingRoutine({ ...editingRoutine, actions });
                            }}
                            placeholder="AI 任务描述，如：根据我的习惯推荐明天的穿搭"
                            rows={2}
                            className="w-full px-2 py-1.5 rounded border border-stone-300 text-xs focus:outline-none focus:ring-1 focus:ring-amber-500/20 resize-none"
                          />
                        )}
                      </div>
                    );
                  })}
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        const id = `act_${Date.now().toString(36)}`;
                        setEditingRoutine({
                          ...editingRoutine,
                          actions: [...(editingRoutine.actions ?? []), { id, type: "notify", trigger: "before", offsetMinutes: 30, channel: "wechat", message: "" }],
                        });
                      }}
                      className="flex-1 py-1.5 rounded-lg border border-dashed border-stone-300 text-xs text-stone-500 hover:border-amber-400 hover:text-amber-600 transition-colors cursor-pointer"
                    >
                      + 通知
                    </button>
                    <button
                      onClick={() => {
                        const id = `act_${Date.now().toString(36)}`;
                        setEditingRoutine({
                          ...editingRoutine,
                          actions: [...(editingRoutine.actions ?? []), { id, type: "plugin", trigger: "before", offsetMinutes: 30, channel: "wechat", toolName: "" }],
                        });
                      }}
                      className="flex-1 py-1.5 rounded-lg border border-dashed border-stone-300 text-xs text-stone-500 hover:border-blue-400 hover:text-blue-600 transition-colors cursor-pointer"
                    >
                      + 插件工具
                    </button>
                    <button
                      onClick={() => {
                        const id = `act_${Date.now().toString(36)}`;
                        setEditingRoutine({
                          ...editingRoutine,
                          actions: [...(editingRoutine.actions ?? []), { id, type: "ai_task", trigger: "before", offsetMinutes: 30, channel: "wechat", prompt: "" }],
                        });
                      }}
                      className="flex-1 py-1.5 rounded-lg border border-dashed border-stone-300 text-xs text-stone-500 hover:border-purple-400 hover:text-purple-600 transition-colors cursor-pointer"
                    >
                      + AI 任务
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setEditingRoutine(null)}
                className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const toSave = { ...editingRoutine };
                  if (toSave.actions?.length) {
                    toSave.reminders = toSave.actions
                      .filter((a) => a.type === "notify")
                      .map((a) => ({
                        offsetMinutes: a.trigger === "before" ? a.offsetMinutes : 0,
                        message: a.message ?? "",
                        channel: a.channel ?? "wechat",
                      }));
                  }
                  saveRoutine(toSave);
                }}
                className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors cursor-pointer"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
