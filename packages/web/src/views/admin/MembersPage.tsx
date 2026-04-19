import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";
import {
  TrashIcon,
  PencilIcon,
  CogIcon,
  XMarkIcon,
  ChevronDownIcon,
  InformationCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { createIconWrapper } from "../../components/ui/Icon";

// 创建包装过的图标组件
const DeleteIcon = createIconWrapper(TrashIcon);
const EditIcon = createIconWrapper(PencilIcon);
const SettingsIcon = createIconWrapper(CogIcon);
const CloseIcon = createIconWrapper(XMarkIcon);
const ChevronIcon = createIconWrapper(ChevronDownIcon);
const InfoIcon = createIconWrapper(InformationCircleIcon);
const WarningIcon = createIconWrapper(ExclamationTriangleIcon);

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

// 常用场景模板
const SCENARIO_TEMPLATES = [
  {
    id: "daily_news",
    name: "每日新闻",
    description: "每天早上播报当日新闻摘要",
    category: "新闻播报",
    template: {
      title: "每日新闻播报",
      weekdays: [1, 2, 3, 4, 5], // 工作日
      time: "08:00",
      actions: [
        {
          id: "act_news_daily",
          type: "ai_task" as const,
          trigger: "at" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          prompt: "获取今日重要新闻资讯，整理成简洁摘要"
        },
        {
          id: "act_news_notify",
          type: "notify" as const,
          trigger: "after" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          message: "{{result}}"
        }
      ]
    }
  },
  {
    id: "weekly_news",
    name: "新闻周刊",
    description: "每周日晚上播报一周新闻汇总",
    category: "新闻播报",
    template: {
      title: "新闻周刊播报",
      weekdays: [0], // 周日
      time: "20:00",
      actions: [
        {
          id: "act_weekly_news",
          type: "plugin" as const,
          trigger: "at" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          toolName: "news_fetch",
          toolParams: { mode: "weekly", limit: 15 }
        },
        {
          id: "act_weekly_notify",
          type: "notify" as const,
          trigger: "after" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          message: "{{result}}"
        }
      ]
    }
  },
  {
    id: "morning_weather",
    name: "早晨天气",
    description: "每天早上播报当日天气和穿衣建议",
    category: "天气播报",
    template: {
      title: "早晨天气播报",
      weekdays: [0, 1, 2, 3, 4, 5, 6], // 每天
      time: "07:30",
      actions: [
        {
          id: "act_weather_morning",
          type: "ai_task" as const,
          trigger: "at" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          prompt: "查询今天的天气情况，并根据天气给出穿衣和出行建议"
        },
        {
          id: "act_weather_notify",
          type: "notify" as const,
          trigger: "after" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          message: "{{result}}"
        }
      ]
    }
  },
  {
    id: "travel_weather",
    name: "出行天气",
    description: "出门前15分钟提醒查看天气",
    category: "天气播报", 
    template: {
      title: "出行天气提醒",
      weekdays: [1, 2, 3, 4, 5], // 工作日
      time: "08:45", // 假设9点出门
      actions: [
        {
          id: "act_travel_weather",
          type: "plugin" as const,
          trigger: "at" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          toolName: "weather_query",
          toolParams: { days: 1 }
        },
        {
          id: "act_travel_notify",
          type: "notify" as const,
          trigger: "after" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          message: "出门前天气提醒：{{result}}"
        }
      ]
    }
  },
  {
    id: "simple_reminder",
    name: "简单提醒",
    description: "发送自定义提醒消息",
    category: "提醒类",
    template: {
      title: "自定义提醒",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      time: "09:00",
      actions: [
        {
          id: "act_simple_reminder",
          type: "notify" as const,
          trigger: "at" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          message: "这是一个自定义提醒，请修改消息内容"
        }
      ]
    }
  },
  {
    id: "scheduled_task",
    name: "定时任务",
    description: "执行AI任务并发送结果",
    category: "提醒类",
    template: {
      title: "定时AI任务",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      time: "12:00",
      actions: [
        {
          id: "act_scheduled_task",
          type: "ai_task" as const,
          trigger: "at" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          prompt: "执行定时任务，请修改具体的任务描述"
        },
        {
          id: "act_task_notify",
          type: "notify" as const,
          trigger: "after" as const,
          offsetMinutes: 0,
          channel: "wechat" as const,
          message: "{{result}}"
        }
      ]
    }
  }
];

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

interface Routine {
  id: string;
  title: string;
  description?: string;
  assigneeMemberIds?: string[];
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
  assigneeMemberIds?: string[];
  routineId?: string;
  title?: string;
  reason?: string;
  startTime?: string;
  endTime?: string;
  time?: string;
  timeSlot?: string;
  actions?: RoutineAction[];
  reminders?: Array<{ offsetMinutes: number; message: string; channel: string }>;
}

interface DayPlanItem {
  id: string;
  title: string;
  timeSlot?: string;
  time?: string;
  source: string;
}

interface MemberDetail {
  member: { id: string; name: string; role: string; avatar?: string; channelBindings: Record<string, string> };
  profile: string;
  routines: Routine[];
  plans?: Override[];
  overrides: Override[];
  dayPlan: { date: string; items: DayPlanItem[] };
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
  const [tab, setTab] = useState<"plan" | "routines" | "overrides" | "profile">("plan");
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

  // AI routine parsing
  const [showAiInput, setShowAiInput] = useState(false);
  const [aiDescription, setAiDescription] = useState("");
  const [aiParsing, setAiParsing] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  
  // 编辑模式：natural（自然语言） | structured（结构化） | template（模板选择）
  const [editMode, setEditMode] = useState<"natural" | "structured" | "template">("natural");
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);

  // Routine preview
  const [showPreview, setShowPreview] = useState(false);
  const [previewRoutine, setPreviewRoutine] = useState<Routine | null>(null);
  const [originalDescription, setOriginalDescription] = useState("");

  // Override editing
  const [editingOverride, setEditingOverride] = useState<Override | null>(null);
  const [deletingOverride, setDeletingOverride] = useState<string | null>(null);

  // Action execution logs
  const [actionLogs, setActionLogs] = useState<Array<{ id: number; routineId: string; actionId: string; result: string; success: boolean; executedAt: string }>>([]);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [triggeringRoutineId, setTriggeringRoutineId] = useState<string | null>(null);

  // Generate routines from profile
  const [generating, setGenerating] = useState(false);
  const [generatedRoutines, setGeneratedRoutines] = useState<Routine[] | null>(null);
  const [selectedGenIdx, setSelectedGenIdx] = useState<Set<number>>(new Set());
  const [applyingGen, setApplyingGen] = useState(false);

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
    setTab("plan");
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
      await fetch(`/api/routines/${selectedId}/${routine.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(routine),
      });
      setEditingRoutine(null);
      setAiWarnings([]);
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
      setPageError(null);
      const selected = generatedRoutines.filter((_, i) => selectedGenIdx.has(i));
      if (selected.length > 0) {
        await fetch(`/api/members/${selectedId}/apply-routines`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routines: selected }),
        });
      }
      setGeneratedRoutines(null);
      await refreshMemberDetail(selectedId);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "应用生成习惯失败");
    }
    setApplyingGen(false);
  }

  async function saveOverride(ovr: Override) {
    if (!selectedId) return;
    try {
      setPageError(null);
      await api.upsertPlan(selectedId, ovr.id, ovr as unknown as Record<string, unknown>);
      setEditingOverride(null);
      await refreshMemberDetail(selectedId);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "保存计划失败");
    }
  }

  async function deleteOverride(ovrId: string) {
    if (!selectedId) return;
    try {
      setPageError(null);
      await api.deletePlan(selectedId, ovrId);
      setDeletingOverride(null);
      await refreshMemberDetail(selectedId);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "删除计划失败");
    }
  }

  async function parseWithAi(descOverride?: unknown) {
    const normalizedOverride = typeof descOverride === "string" ? descOverride : undefined;
    const desc = asText(normalizedOverride ?? aiDescription);
    if (!selectedId || !desc.trim() || aiParsing) return;
    setAiParsing(true);
    setAiError(null);
    setAiWarnings([]);
    try {
      const res = await api.parseRoutine(selectedId, desc.trim());
      if (res.ok && res.routine) {
        const r = res.routine as unknown as Routine;
        const processedRoutine = editingRoutine ? {
          ...r,
          id: editingRoutine.id,
          title: asText(r.title || editingRoutine.title),
          weekdays: Array.isArray(r.weekdays) ? r.weekdays : editingRoutine.weekdays,
          description: desc.trim(),
        } : r;

        // Show preview instead of directly setting editingRoutine
        setPreviewRoutine(processedRoutine);
        setOriginalDescription(desc.trim());
        setAiWarnings(res.warnings ?? []);
        setShowPreview(true);
        setShowAiInput(false);
        setAiDescription("");
      } else {
        setAiError(res.error ?? "解析失败，请重试");
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "请求失败");
    }
    setAiParsing(false);
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

  function formatActionChain(actions: RoutineAction[]): string[] {
    return actions.map((a) => {
      const trigLabels: Record<string, string> = { before: "提前", at: "到时", after: "延后" };
      const trigStr = a.trigger === "at" ? "到时" : `${trigLabels[a.trigger]}${a.offsetMinutes}分`;
      switch (a.type) {
        case "notify":
          return `${trigStr} → 微信通知：「${a.message ?? ""}」`;
        case "ai_task":
          return `${trigStr} → AI 执行任务：${a.prompt ?? ""}`;
        case "plugin":
          return `${trigStr} → 调用插件工具：${a.toolName ?? ""}`;
        default:
          return `${trigStr} → ${a.type}`;
      }
    });
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
                ["plan", "今日计划"],
                ["routines", "7 days"],
                ["overrides", "计划"],
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
                              {item.source === "routine" || item.source === "family_routine" ? "7days" : "计划"}
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
                        onClick={() => { setShowAiInput(true); setAiDescription(""); setAiError(null); }}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors cursor-pointer"
                      >
                        + 新增习惯
                      </button>
                      <button
                        onClick={() => {
                          const newRoutine: Routine = {
                            id: `rtn_${Date.now().toString(36)}`,
                            title: "新习惯",
                            description: "",
                            weekdays: [0, 1, 2, 3, 4, 5, 6],
                            time: "09:00",
                            reminders: [],
                            actions: [],
                          };
                          setEditingRoutine(newRoutine);
                          setEditMode("template");
                          setSelectedTemplate(null);
                        }}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 transition-colors cursor-pointer"
                      >
                        📋 模板
                      </button>
                    </div>
                  </div>

                  {/* AI smart input */}
                  {showAiInput && (
                    <div className="mb-4 p-4 rounded-lg border border-amber-200 bg-amber-50/30 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-stone-600">描述你的习惯，AI 会解析后显示预览供确认</p>
                        <button
                          onClick={() => setShowAiInput(false)}
                          className="p-1 rounded text-stone-400 hover:text-stone-600 transition-colors"
                        >
                          <CloseIcon size="md" />
                        </button>
                      </div>
                      <textarea
                        value={aiDescription}
                        onChange={(e) => setAiDescription(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) parseWithAi();
                        }}
                        placeholder={"例如：\n• 周一三五晚上7点去健身，提前半小时提醒带装备\n• 每天早上8点吃早餐，查一下当天天气\n• 每周日下午做一次大扫除"}
                        rows={3}
                        className="w-full px-3 py-2 rounded-lg border border-stone-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 resize-none"
                        disabled={aiParsing}
                      />
                      {aiError && (
                        <p className="text-xs text-red-500">{aiError}</p>
                      )}
                      <div className="flex items-center justify-between">
                        <button
                          onClick={() => {
                            setShowAiInput(false);
                            setEditingRoutine({
                              id: `rtn_${Date.now().toString(36)}`,
                              title: "",
                              weekdays: [],
                              reminders: [],
                              actions: [],
                            });
                          }}
                          className="text-xs text-stone-400 hover:text-stone-600 transition-colors"
                        >
                          手动创建
                        </button>
                        <button
                          onClick={() => { void parseWithAi(); }}
                    disabled={!asText(aiDescription).trim() || aiParsing}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
                        >
                          {aiParsing ? (
                            <>
                              <span className="w-3 h-3 border-2 border-white/60 border-t-white rounded-full animate-spin" />
                              AI 解析中…
                            </>
                          ) : (
                            "AI 解析"
                          )}
                        </button>
                      </div>
                    </div>
                  )}

                  {detail.routines.length === 0 ? (
                    <div className="py-6 text-center space-y-3">
                      <p className="text-sm text-stone-400">暂无习惯</p>
                      <p className="text-xs text-stone-400">
                        点击「+ 新增习惯」用自然语言描述，AI 帮你创建
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
                                    家庭计划
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
                                  setEditingRoutine({
                                    ...r,
                                    title: asText(r.title),
                                    description: asText(r.description),
                                  });
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

            {/* Overrides tab */}
            {tab === "overrides" && (
              <div className="space-y-4">
                <div className="bg-white rounded-xl border border-stone-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-medium text-stone-500">
                      计划 · {detail.overrides.length} 项
                    </h3>
                    <button
                      onClick={() => {
                        setEditingOverride({
                          id: `ovr_${Date.now().toString(36)}`,
                          action: "skip",
                          date: new Date().toISOString().split("T")[0],
                        });
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors cursor-pointer"
                    >
                      + 新增计划
                    </button>
                  </div>

                  {detail.overrides.length === 0 ? (
                    <div className="py-6 text-center space-y-2">
                      <p className="text-sm text-stone-400">暂无计划</p>
                      <p className="text-xs text-stone-400">计划用于在某个时间段内执行特定内容，或调整既有 7 days</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {detail.overrides.map((ovr) => {
                        const actionLabels: Record<string, { text: string; color: string }> = {
                          skip: { text: "跳过", color: "bg-red-50 text-red-600" },
                          add: { text: "新增", color: "bg-green-50 text-green-600" },
                          modify: { text: "修改", color: "bg-blue-50 text-blue-600" },
                        };
                        const a = actionLabels[ovr.action] ?? { text: ovr.action, color: "bg-stone-100 text-stone-500" };
                        return (
                          <div key={ovr.id} className="flex items-center gap-3 p-3 rounded-lg bg-stone-50 group">
                            <span className={`text-xs px-2 py-0.5 rounded font-medium ${a.color}`}>{a.text}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-stone-700">{ovr.title ?? ovr.reason ?? "计划安排"}</p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <p className="text-xs text-stone-400">
                                  {ovr.date
                                    ? ovr.date
                                    : ovr.dateRange
                                      ? `${ovr.dateRange.start} ~ ${ovr.dateRange.end}`
                                      : ""}
                                </p>
                                {ovr.timeSlot && (
                                  <span className="text-xs text-stone-400">{formatTimeSlot(ovr.timeSlot)}</span>
                                )}
                                {ovr.routineId && (
                                  <span className="text-xs bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded">
                                    覆盖: {detail.routines.find((r) => r.id === ovr.routineId)?.title ?? ovr.routineId}
                                  </span>
                                )}
                                {ovr.assigneeMemberIds && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">
                                    家庭计划
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => {
                                  if (ovr.assigneeMemberIds) {
                                    navigate("/admin/family");
                                    return;
                                  }
                                  setEditingOverride({ ...ovr });
                                }}
                                className="p-1.5 rounded-md text-stone-400 hover:text-amber-600 hover:bg-amber-50 transition-colors cursor-pointer"
                                title="编辑"
                              >
                                <EditIcon size="md" />
                              </button>
                              <button
                                onClick={() => {
                                  if (!ovr.assigneeMemberIds) setDeletingOverride(ovr.id);
                                }}
                                className="p-1.5 rounded-md text-stone-400 hover:text-red-500 hover:bg-red-50 transition-colors cursor-pointer"
                                title={ovr.assigneeMemberIds ? "请在家庭页面删除" : "删除"}
                              >
                                <DeleteIcon size="md" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 家庭项编辑统一在“家庭”页面处理 */}

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

      {/* AI Parsing Preview Dialog */}
      {showPreview && previewRoutine && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowPreview(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-stone-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-stone-800 mb-1">AI解析结果预览</h3>
                  <p className="text-sm text-stone-500">请检查解析结果是否符合预期，可以修改后再保存</p>
                </div>
                {/* Confidence indicator */}
                {(previewRoutine as any)?.confidence !== undefined && (
                  <div className="text-right">
                    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${
                      (previewRoutine as any).confidence >= 0.8 
                        ? "bg-green-100 text-green-700"
                        : (previewRoutine as any).confidence >= 0.6
                        ? "bg-yellow-100 text-yellow-700"  
                        : "bg-red-100 text-red-700"
                    }`}>
                      <span className={`w-2 h-2 rounded-full ${
                        (previewRoutine as any).confidence >= 0.8 
                          ? "bg-green-500"
                          : (previewRoutine as any).confidence >= 0.6
                          ? "bg-yellow-500"
                          : "bg-red-500"
                      }`} />
                      置信度: {((previewRoutine as any).confidence * 100).toFixed(0)}%
                    </div>
                    <p className="text-xs text-stone-400 mt-1">
                      {(previewRoutine as any).confidence >= 0.8 
                        ? "解析质量良好" 
                        : (previewRoutine as any).confidence >= 0.6
                        ? "建议检查调整"
                        : "需要仔细检查"}
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="p-6 max-h-[calc(90vh-200px)] overflow-y-auto">
              <div className="space-y-6">
                {/* Original description */}
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-2">原始描述</label>
                  <div className="px-3 py-2 rounded-lg bg-stone-50 border border-stone-200 text-sm text-stone-700">
                    {originalDescription}
                  </div>
                </div>

                {/* Parsed results */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-2">习惯名称</label>
                    <input
                      type="text"
                      value={previewRoutine.title}
                      onChange={(e) => setPreviewRoutine({ ...previewRoutine, title: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-2">执行时间</label>
                    <input
                      type="time"
                      value={previewRoutine.time || ""}
                      onChange={(e) => setPreviewRoutine({ ...previewRoutine, time: e.target.value || undefined })}
                      className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                    />
                  </div>
                </div>

                {/* Weekdays */}
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-2">重复周期</label>
                  <div className="flex gap-2">
                    {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                      <button
                        key={d}
                        onClick={() => {
                          const wds = previewRoutine.weekdays.includes(d)
                            ? previewRoutine.weekdays.filter((x) => x !== d)
                            : [...previewRoutine.weekdays, d].sort();
                          setPreviewRoutine({ ...previewRoutine, weekdays: wds });
                        }}
                        className={`w-9 h-9 rounded-full text-sm font-medium transition-colors ${
                          previewRoutine.weekdays.includes(d)
                            ? "bg-amber-500 text-white"
                            : "bg-stone-100 text-stone-400 hover:bg-stone-200"
                        }`}
                      >
                        {WEEKDAY_NAMES[d]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Action chain preview */}
                {(previewRoutine.actions ?? []).length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-2">执行链路预览</label>
                    <div className="space-y-2">
                      {formatActionChain(previewRoutine.actions ?? []).map((line, i) => {
                        const action = previewRoutine.actions![i]!;
                        const colors: Record<string, string> = {
                          notify: "border-l-blue-400 bg-blue-50/50",
                          plugin: "border-l-teal-400 bg-teal-50/50",
                          ai_task: "border-l-purple-400 bg-purple-50/50",
                        };
                        const icons: Record<string, string> = { notify: "🔔", plugin: "🔧", ai_task: "🤖" };
                        return (
                          <div key={i} className={`px-3 py-2 rounded-r-lg border-l-3 text-xs text-stone-700 ${colors[action.type] ?? "border-l-stone-300 bg-stone-50"}`}>
                            <span className="mr-2">{icons[action.type]}</span>
                            {line}
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-xs text-stone-400 mt-2">
                      💡 执行顺序：AI任务先执行，然后发送通知给用户
                    </p>
                  </div>
                )}

                {/* Warnings */}
                {aiWarnings.length > 0 && (
                  <div className="p-4 rounded-lg bg-yellow-50 border border-yellow-200">
                    <h4 className="text-sm font-medium text-yellow-800 mb-2">解析提醒</h4>
                    <div className="space-y-1">
                      {aiWarnings.map((w, i) => (
                        <p key={i} className="text-xs text-yellow-700 flex items-start gap-1.5">
                          <span className="mt-0.5 flex-shrink-0">⚠️</span>
                          {w}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="p-6 border-t border-stone-200 bg-stone-50 flex justify-between items-center">
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowPreview(false);
                    setShowAiInput(true);
                    setAiDescription(originalDescription);
                  }}
                  className="px-4 py-2 rounded-lg text-sm text-amber-600 bg-amber-50 hover:bg-amber-100 transition-colors"
                >
                  重新解析
                </button>
                <button
                  onClick={() => setShowPreview(false)}
                  className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 transition-colors"
                >
                  取消
                </button>
              </div>
              
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    // Apply preview to editing routine and close preview
                    setEditingRoutine(previewRoutine);
                    setShowPreview(false);
                    setAiWarnings(aiWarnings); // Keep warnings for main editor
                  }}
                  className="px-4 py-2 rounded-lg text-sm text-stone-700 bg-stone-200 hover:bg-stone-300 transition-colors"
                >
                  继续编辑
                </button>
                <button
                  onClick={async () => {
                    // Save directly from preview
                    if (selectedId && previewRoutine) {
                      try {
                        await saveRoutine(previewRoutine);
                        setShowPreview(false);
                        setPreviewRoutine(null);
                        setOriginalDescription("");
                        setAiWarnings([]);
                      } catch (err) {
                        // Error handling is done in saveRoutine
                      }
                    }
                  }}
                  className="px-4 py-2 rounded-lg bg-green-500 text-white text-sm font-medium hover:bg-green-600 transition-colors"
                >
                  直接保存
                </button>
              </div>
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

      {/* Edit routine dialog */}
      {editingRoutine && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => { setEditingRoutine(null); setAiWarnings([]); }}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-stone-800 mb-4">
              {detail?.routines.some((r) => r.id === editingRoutine.id) ? "编辑 7 days 习惯" : "新增 7 days 习惯"}
            </h3>
            
            {/* 模式切换器 */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-stone-600">配置方式</p>
                <div className="flex rounded-lg bg-stone-100 p-1">
                  <button
                    onClick={() => setEditMode("template")}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      editMode === "template"
                        ? "bg-white text-amber-700 shadow-sm"
                        : "text-stone-600 hover:text-stone-800"
                    }`}
                  >
                    模板
                  </button>
                  <button
                    onClick={() => setEditMode("natural")}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      editMode === "natural"
                        ? "bg-white text-amber-700 shadow-sm"
                        : "text-stone-600 hover:text-stone-800"
                    }`}
                  >
                    自然语言
                  </button>
                  <button
                    onClick={() => setEditMode("structured")}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      editMode === "structured"
                        ? "bg-white text-amber-700 shadow-sm"
                        : "text-stone-600 hover:text-stone-800"
                    }`}
                  >
                    结构化
                  </button>
                </div>
              </div>
              <p className="text-xs text-stone-500">
                {editMode === "template" 
                  ? "选择预设模板快速创建常用习惯"
                  : editMode === "natural" 
                  ? "用自然语言描述，AI 自动生成配置" 
                  : "手动配置每个执行步骤和参数"
                }
              </p>
            </div>
            
            {editMode === "template" ? (
              // 模板选择模式
              <div className="space-y-4">
                <div className="grid gap-3">
                  {Object.entries(
                    SCENARIO_TEMPLATES.reduce((groups, template) => {
                      const category = template.category;
                      if (!groups[category]) groups[category] = [];
                      groups[category].push(template);
                      return groups;
                    }, {} as Record<string, typeof SCENARIO_TEMPLATES>)
                  ).map(([category, templates]) => (
                    <div key={category}>
                      <h4 className="text-sm font-medium text-stone-700 mb-2">{category}</h4>
                      <div className="grid grid-cols-1 gap-2">
                        {templates.map((template) => (
                          <button
                            key={template.id}
                            onClick={() => {
                              // 应用模板到当前编辑的习惯
                              setEditingRoutine({
                                ...editingRoutine,
                                ...template.template,
                                id: editingRoutine.id, // 保持原有ID
                                description: editingRoutine.description, // 保持原有描述
                              });
                              setSelectedTemplate(template.id);
                            }}
                            className={`p-3 rounded-lg border text-left transition-colors ${
                              selectedTemplate === template.id
                                ? "border-amber-500 bg-amber-50"
                                : "border-stone-200 hover:border-stone-300 hover:bg-stone-50"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <h5 className="text-sm font-medium text-stone-800">{template.name}</h5>
                              {selectedTemplate === template.id && (
                                <span className="text-xs text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full">
                                  已选择
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-stone-500">{template.description}</p>
                            <div className="flex items-center gap-2 mt-2">
                              <span className="text-xs text-stone-400">
                                {template.template.weekdays.map(d => WEEKDAY_NAMES[d]).join("、")}
                              </span>
                              {template.template.time && (
                                <span className="text-xs text-stone-400">
                                  {template.template.time}
                                </span>
                              )}
                              <span className="text-xs text-stone-400">
                                {template.template.actions?.length || 0}个步骤
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {selectedTemplate && (
                  <div className="p-4 rounded-lg border border-green-200 bg-green-50/30">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-medium text-green-800">模板已应用</h4>
                      <button
                        onClick={() => setEditMode("natural")}
                        className="text-xs text-green-600 hover:text-green-700 font-medium"
                      >
                        继续编辑 →
                      </button>
                    </div>
                    <p className="text-xs text-green-700">
                      可以切换到其他模式进行个性化调整，或直接保存使用当前配置。
                    </p>
                  </div>
                )}
              </div>
            ) : editMode === "natural" ? (
              // 自然语言模式
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

              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">具体时间</label>
                <input
                  type="time"
                  value={editingRoutine.time ?? ""}
                  onChange={(e) => setEditingRoutine({ ...editingRoutine, time: e.target.value || undefined })}
                  className="w-full px-3 py-2.5 rounded-xl border border-stone-200 bg-stone-50 text-sm font-medium text-stone-700 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-400 focus:bg-white transition-all [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">习惯描述</label>
                <textarea
                  value={asText(editingRoutine.description)}
                  onChange={(e) => setEditingRoutine({ ...editingRoutine, description: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && asText(editingRoutine.description).trim()) {
                      parseWithAi(asText(editingRoutine.description));
                    }
                  }}
                  placeholder={"用自然语言描述这个习惯，AI 会自动识别执行方式\n例如：告诉我明天的天气预报、提前半小时提醒带健身装备"}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 resize-none"
                  disabled={aiParsing}
                />
                <div className="flex items-center justify-between mt-2">
                  <p className="text-[11px] text-stone-400">Cmd+Enter 快速解析</p>
                  <button
                    onClick={() => parseWithAi(asText(editingRoutine.description))}
                    disabled={!asText(editingRoutine.description).trim() || aiParsing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
                  >
                    {aiParsing ? (
                      <>
                        <span className="w-3 h-3 border-2 border-white/60 border-t-white rounded-full animate-spin" />
                        解析中…
                      </>
                    ) : (
                      "AI 解析"
                    )}
                  </button>
                </div>
                {aiError && (
                  <p className="text-xs text-red-500 mt-1">{aiError}</p>
                )}
              </div>

              {aiWarnings.length > 0 && (
                <div className="p-3 rounded-lg bg-yellow-50 border border-yellow-200">
                  {aiWarnings.map((w, i) => (
                    <p key={i} className="text-xs text-yellow-700 flex items-start gap-1.5">
                      <span className="mt-0.5 flex-shrink-0">⚠️</span>
                      {w}
                    </p>
                  ))}
                </div>
              )}

              {(editingRoutine.actions ?? []).length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-2">执行链路</label>
                  <div className="space-y-1.5">
                    {formatActionChain(editingRoutine.actions ?? []).map((line, i) => {
                      const action = editingRoutine.actions![i]!;
                      const colors: Record<string, string> = {
                        notify: "border-l-blue-400 bg-blue-50/50",
                        plugin: "border-l-teal-400 bg-teal-50/50",
                        ai_task: "border-l-purple-400 bg-purple-50/50",
                      };
                      const icons: Record<string, string> = { notify: "🔔", plugin: "🔧", ai_task: "🤖" };
                      return (
                        <div key={i} className={`px-3 py-2 rounded-r-lg border-l-3 text-xs text-stone-700 ${colors[action.type] ?? "border-l-stone-300 bg-stone-50"}`}>
                          <span className="mr-1">{icons[action.type]}</span>
                          {line}
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-stone-400 mt-1.5">通知会发送到微信，执行结果可在下方“最近执行记录”查看</p>
                </div>
              )}
              </div>
            ) : (
              // 结构化配置模式 - 简化版本，先实现基础功能
              <div className="space-y-4">
                {/* 基本信息 */}
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

                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">具体时间</label>
                  <input
                    type="time"
                    value={editingRoutine.time ?? ""}
                    onChange={(e) => setEditingRoutine({ ...editingRoutine, time: e.target.value || undefined })}
                    className="w-full px-3 py-2.5 rounded-xl border border-stone-200 bg-stone-50 text-sm font-medium text-stone-700 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-400 focus:bg-white transition-all [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                  />
                </div>

                {/* 简化的Actions配置 */}
                <div className="p-4 rounded-lg border border-amber-200 bg-amber-50/30">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-medium text-stone-700">执行步骤配置</h4>
                    <span className="text-xs text-amber-600 bg-amber-100 px-2 py-1 rounded-full">高级功能</span>
                  </div>
                  <p className="text-xs text-stone-600 mb-3">
                    结构化配置模式正在完善中，当前推荐使用自然语言模式进行配置。
                  </p>
                  <button
                    onClick={() => setEditMode("natural")}
                    className="text-xs text-amber-600 hover:text-amber-700 font-medium"
                  >
                    切换到自然语言模式 →
                  </button>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => { setEditingRoutine(null); setAiWarnings([]); }}
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
                        channel: "wechat",
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

      {/* 家庭项编辑统一在“家庭”页面处理 */}

      {/* Delete plan confirmation dialog */}
      {deletingOverride && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setDeletingOverride(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-stone-800 mb-2">删除计划</h3>
            <p className="text-sm text-stone-500 mb-6">确定要删除这条计划吗？</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeletingOverride(null)} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 transition-colors">取消</button>
              <button onClick={() => deleteOverride(deletingOverride)} className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors">删除</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit plan dialog */}
      {editingOverride && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setEditingOverride(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-stone-800 mb-4">
              {detail?.overrides.some((o) => o.id === editingOverride.id) ? "编辑计划" : "新增计划"}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">计划类型</label>
                <select
                  value={editingOverride.action}
                  onChange={(e) => setEditingOverride({ ...editingOverride, action: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                >
                  <option value="skip">暂停（跳过某段时间内的习惯）</option>
                  <option value="add">新增（在时间段内执行内容）</option>
                  <option value="modify">调整（替换原习惯执行内容）</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-500 mb-2">时间范围</label>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-stone-600">
                    <input
                      type="radio"
                      name="dateMode"
                      checked={!editingOverride.dateRange}
                      onChange={() => {
                        const { dateRange: _, ...rest } = editingOverride;
                        void _;
                        setEditingOverride({ ...rest, date: editingOverride.date || new Date().toISOString().split("T")[0] });
                      }}
                      className="text-amber-500 focus:ring-amber-500/20"
                    />
                    单日
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-stone-600">
                    <input
                      type="radio"
                      name="dateMode"
                      checked={!!editingOverride.dateRange}
                      onChange={() => {
                        const today = new Date().toISOString().split("T")[0]!;
                        const { date: _, ...rest } = editingOverride;
                        void _;
                        setEditingOverride({ ...rest, dateRange: { start: today, end: today } });
                      }}
                      className="text-amber-500 focus:ring-amber-500/20"
                    />
                    时间段
                  </label>
                </div>
                {!editingOverride.dateRange ? (
                  <input
                    type="date"
                    value={editingOverride.date ?? ""}
                    onChange={(e) => setEditingOverride({ ...editingOverride, date: e.target.value })}
                    className="mt-2 w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  />
                ) : (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-stone-400 mb-0.5">开始日期</label>
                      <input
                        type="date"
                        value={editingOverride.dateRange.start}
                        onChange={(e) => setEditingOverride({ ...editingOverride, dateRange: { ...editingOverride.dateRange!, start: e.target.value } })}
                        className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-stone-400 mb-0.5">结束日期</label>
                      <input
                        type="date"
                        value={editingOverride.dateRange.end}
                        onChange={(e) => setEditingOverride({ ...editingOverride, dateRange: { ...editingOverride.dateRange!, end: e.target.value } })}
                        className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">开始时间</label>
                  <input
                    type="time"
                    value={editingOverride.startTime ?? editingOverride.time ?? ""}
                    onChange={(e) => setEditingOverride({ ...editingOverride, startTime: e.target.value || undefined, time: e.target.value || undefined })}
                    className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">结束时间</label>
                  <input
                    type="time"
                    value={editingOverride.endTime ?? ""}
                    onChange={(e) => setEditingOverride({ ...editingOverride, endTime: e.target.value || undefined })}
                    className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">时段（可选）</label>
                <select
                  value={editingOverride.timeSlot ?? ""}
                  onChange={(e) => setEditingOverride({ ...editingOverride, timeSlot: e.target.value || undefined })}
                  className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                >
                  <option value="">全天</option>
                  <option value="morning">上午</option>
                  <option value="afternoon">下午</option>
                  <option value="evening">晚上</option>
                </select>
              </div>

              {(editingOverride.action === "skip" || editingOverride.action === "modify") && detail && detail.routines.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">覆盖的 7 days 习惯</label>
                  <select
                    value={editingOverride.routineId ?? ""}
                    onChange={(e) => setEditingOverride({ ...editingOverride, routineId: e.target.value || undefined })}
                    className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  >
                    <option value="">所有习惯（该时段内全部覆盖）</option>
                    {detail.routines.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title} ({formatWeekdays(r.weekdays)}{r.time ? ` ${r.time}` : ""})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {editingOverride.action !== "skip" && (
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">计划内容</label>
                  <input
                    type="text"
                    value={editingOverride.title ?? ""}
                    onChange={(e) => setEditingOverride({ ...editingOverride, title: e.target.value })}
                    placeholder="如：出差、团建、去医院复查"
                    className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">原因（可选）</label>
                <input
                  type="text"
                  value={editingOverride.reason ?? ""}
                  onChange={(e) => setEditingOverride({ ...editingOverride, reason: e.target.value })}
                  placeholder="如：公司团建、身体不适"
                  className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setEditingOverride(null)} className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 transition-colors cursor-pointer">取消</button>
              <button onClick={() => saveOverride(editingOverride)} className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors cursor-pointer">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
