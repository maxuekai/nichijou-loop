import { useEffect, useState, useCallback } from "react";
import { api } from "../../api";
import { Select } from "../../components/ui/Select";

interface ReminderItem {
  id: string;
  memberId: string;
  message: string;
  triggerAt: string;
  channel: string;
  done: boolean;
  createdAt: string;
}

interface MemberInfo {
  id: string;
  name: string;
}

const REMINDER_STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "pending", label: "待触发" },
  { value: "done", label: "已完成" },
];

const REMINDER_CHANNEL_OPTIONS = [
  { value: "wechat", label: "微信" },
  { value: "dashboard", label: "面板" },
  { value: "both", label: "两者" },
];

export function RemindersPage() {
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [filterMember, setFilterMember] = useState("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "done">("all");
  const [editing, setEditing] = useState<ReminderItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ memberId: "", message: "", triggerAt: "", channel: "wechat" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, f] = await Promise.all([
        api.getReminders(),
        api.getFamily(),
      ]);
      setReminders(r);
      setMembers(f.members as MemberInfo[]);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  const getMemberName = (memberId: string) =>
    members.find((m) => m.id === memberId)?.name ?? memberId;

  const filtered = reminders.filter((r) => {
    if (filterMember !== "all" && r.memberId !== filterMember) return false;
    if (filterStatus === "pending" && r.done) return false;
    if (filterStatus === "done" && !r.done) return false;
    return true;
  });

  const pendingCount = reminders.filter((r) => !r.done).length;
  const doneCount = reminders.filter((r) => r.done).length;

  async function handleDelete(id: string) {
    if (!confirm("确定删除这条提醒？")) return;
    try {
      await api.deleteReminder(id);
      await load();
    } catch { /* ignore */ }
  }

  async function handleSaveEdit() {
    if (!editing) return;
    setSaving(true);
    try {
      await api.updateReminder(editing.id, {
        message: form.message,
        triggerAt: form.triggerAt,
        channel: form.channel,
      });
      setEditing(null);
      await load();
    } catch { /* ignore */ }
    setSaving(false);
  }

  async function handleCreate() {
    if (!form.memberId || !form.message || !form.triggerAt) return;
    setSaving(true);
    try {
      await api.createReminder({
        memberId: form.memberId,
        message: form.message,
        triggerAt: form.triggerAt,
        channel: form.channel,
      });
      setCreating(false);
      setForm({ memberId: "", message: "", triggerAt: "", channel: "wechat" });
      await load();
    } catch { /* ignore */ }
    setSaving(false);
  }

  function openEdit(r: ReminderItem) {
    setEditing(r);
    setForm({
      memberId: r.memberId,
      message: r.message,
      triggerAt: r.triggerAt.replace(" ", "T").slice(0, 16),
      channel: r.channel,
    });
  }

  function openCreate() {
    setCreating(true);
    setForm({ memberId: members[0]?.id ?? "", message: "", triggerAt: "", channel: "wechat" });
  }

  function formatTriggerAt(dt: string) {
    try {
      return new Date(dt).toLocaleString("zh-CN", {
        month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
        weekday: "short",
      });
    } catch { return dt; }
  }

  function getStatusInfo(r: ReminderItem) {
    if (r.done) return { label: "已完成", color: "bg-green-50 text-green-700" };
    const now = Date.now();
    const trigger = new Date(r.triggerAt).getTime();
    if (trigger <= now) return { label: "已过期", color: "bg-red-50 text-red-700" };
    const diff = trigger - now;
    if (diff < 3600000) return { label: `${Math.ceil(diff / 60000)}分钟后`, color: "bg-amber-50 text-amber-700" };
    if (diff < 86400000) {
      const h = Math.floor(diff / 3600000);
      return { label: `${h}小时后`, color: "bg-blue-50 text-blue-700" };
    }
    return { label: "待触发", color: "bg-stone-50 text-stone-600" };
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-stone-800">提醒事项</h1>
          <p className="text-sm text-stone-500 mt-1">
            管理独立提醒，待触发 {pendingCount} 项，已完成 {doneCount} 项
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select
            value={filterStatus}
            onChange={(next) => setFilterStatus(next as "all" | "pending" | "done")}
            options={REMINDER_STATUS_OPTIONS}
            className="w-36"
          />
          <Select
            value={filterMember}
            onChange={setFilterMember}
            options={[
              { value: "all", label: "全部成员" },
              ...members.map((m) => ({ value: m.id, label: m.name })),
            ]}
            className="w-40"
          />
          <button
            onClick={openCreate}
            className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm hover:bg-amber-700 transition-colors"
          >
            + 新建提醒
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <p className="text-4xl mb-3">⏰</p>
          <p className="text-stone-400">暂无提醒事项</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => {
            const status = getStatusInfo(r);
            return (
              <div
                key={r.id}
                className={`bg-white rounded-xl border border-stone-200 p-4 flex items-center gap-4 ${r.done ? "opacity-60" : ""}`}
              >
                <div className="flex-shrink-0 text-2xl">
                  {r.done ? "✅" : "⏰"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-stone-800">{r.message}</p>
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 text-xs font-medium">
                      {getMemberName(r.memberId)}
                    </span>
                    <span className="text-xs text-stone-500">
                      {formatTriggerAt(r.triggerAt)}
                    </span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${status.color}`}>
                      {status.label}
                    </span>
                    <span className="text-xs text-stone-400">
                      {r.channel === "wechat" ? "📱微信" : r.channel === "dashboard" ? "🖥面板" : "📱+🖥"}
                    </span>
                  </div>
                </div>
                {!r.done && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => openEdit(r)}
                      className="px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-100 rounded-lg transition-colors"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handleDelete(r.id)}
                      className="px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      删除
                    </button>
                  </div>
                )}
                {r.done && (
                  <button
                    onClick={() => handleDelete(r.id)}
                    className="px-3 py-1.5 text-xs text-stone-400 hover:bg-stone-100 rounded-lg transition-colors flex-shrink-0"
                  >
                    移除
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit Dialog */}
      {editing && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-stone-800 mb-4">编辑提醒</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">提醒内容</label>
                <input
                  type="text"
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">触发时间</label>
                <input
                  type="datetime-local"
                  value={form.triggerAt}
                  onChange={(e) => setForm({ ...form, triggerAt: e.target.value })}
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">通道</label>
                <Select
                  value={form.channel}
                  onChange={(next) => setForm({ ...form, channel: next })}
                  options={REMINDER_CHANNEL_OPTIONS}
                  className="w-full"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setEditing(null)}
                className="px-4 py-2 text-sm text-stone-600 hover:bg-stone-100 rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                className="px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
              >
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Dialog */}
      {creating && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setCreating(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-stone-800 mb-4">新建提醒</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">成员</label>
                <Select
                  value={form.memberId}
                  onChange={(next) => setForm({ ...form, memberId: next })}
                  options={members.map((m) => ({ value: m.id, label: m.name }))}
                  placeholder="选择成员"
                  disabled={members.length === 0}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">提醒内容</label>
                <input
                  type="text"
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                  placeholder="例：记得取快递"
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">触发时间</label>
                <input
                  type="datetime-local"
                  value={form.triggerAt}
                  onChange={(e) => setForm({ ...form, triggerAt: e.target.value })}
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">通道</label>
                <Select
                  value={form.channel}
                  onChange={(next) => setForm({ ...form, channel: next })}
                  options={REMINDER_CHANNEL_OPTIONS}
                  className="w-full"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setCreating(false)}
                className="px-4 py-2 text-sm text-stone-600 hover:bg-stone-100 rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={saving || !form.message || !form.triggerAt}
                className="px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
              >
                {saving ? "创建中..." : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
