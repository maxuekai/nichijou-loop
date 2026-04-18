import { useEffect, useState, useCallback } from "react";
import {
  TrashIcon,
} from "@heroicons/react/24/outline";
import { createIconWrapper } from "../../components/ui/Icon";

// 创建包装过的图标组件
const DeleteIcon = createIconWrapper(TrashIcon);

interface WeChatConnection {
  connectionId: string;
  memberId: string | null;
  memberName: string | null;
  wechatUserId: string;
  status: string;
  connectedAt?: string;
  lastError?: string;
}

interface WeChatStatus {
  available: boolean;
  status?: { connected: boolean; totalMembers: number; connectedMembers: number };
  connections: WeChatConnection[];
  pairing: { active: boolean; connectionId?: string; qrUrl?: string };
}

interface FamilyMember {
  id: string;
  name: string;
  role: string;
}

const STATUS_LABELS: Record<string, { text: string; dot: string; bg: string }> = {
  connected: { text: "在线", dot: "bg-green-500", bg: "bg-green-50 text-green-700" },
  disconnected: { text: "离线", dot: "bg-stone-400", bg: "bg-stone-100 text-stone-500" },
  expired: { text: "需重新扫码", dot: "bg-red-500", bg: "bg-red-50 text-red-600" },
};

export function WeChatPage() {
  const [status, setStatus] = useState<WeChatStatus | null>(null);
  const [pairing, setPairing] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Binding state
  const [bindingConn, setBindingConn] = useState<WeChatConnection | null>(null);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string>("");
  const [newMemberName, setNewMemberName] = useState("");
  const [bindMode, setBindMode] = useState<"select" | "create">("select");
  const [bindLoading, setBindLoading] = useState(false);
  const [deletingConn, setDeletingConn] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/wechat/status");
      if (!res.ok) return;
      const data = await res.json() as WeChatStatus;
      if (!data) return;
      setStatus({
        available: data.available ?? false,
        status: data.status,
        connections: data.connections ?? [],
        pairing: data.pairing ?? { active: false },
      });

      // Auto-detect completed pairing: connection appeared that is unbound
      if (pairing && data.connections?.some((c) => !c.memberId)) {
        const unboundConn = data.connections.find((c) => !c.memberId);
        if (unboundConn) {
          setPairing(false);
          setQrUrl(null);
          openBindDialog(unboundConn);
        }
      }
    } catch {
      // ignore
    }
  }, [pairing]);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 3000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  async function loadMembers() {
    try {
      const res = await fetch("/api/family");
      if (!res.ok) return;
      const data = await res.json() as { members: FamilyMember[] };
      setMembers(data.members ?? []);
    } catch { /* ignore */ }
  }

  function openBindDialog(conn: WeChatConnection) {
    setBindingConn(conn);
    setSelectedMemberId("");
    setNewMemberName("");
    setBindMode("select");
    loadMembers();
  }

  async function startPairing() {
    setError(null);
    setPairing(true);
    try {
      const res = await fetch("/api/wechat/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json() as { ok: boolean; qrUrl?: string; error?: string };
      if (data.ok && data.qrUrl) {
        setQrUrl(data.qrUrl);
      } else {
        setError(data.error ?? "无法生成二维码");
        setPairing(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败");
      setPairing(false);
    }
  }

  async function cancelPairing() {
    await fetch("/api/wechat/pair/cancel", { method: "POST" });
    setPairing(false);
    setQrUrl(null);
    loadStatus();
  }

  async function submitBind() {
    if (!bindingConn) return;
    setBindLoading(true);
    try {
      const body: Record<string, string> = { connectionId: bindingConn.connectionId };
      if (bindMode === "select" && selectedMemberId) {
        body.memberId = selectedMemberId;
      } else if (bindMode === "create" && newMemberName.trim()) {
        body.newMemberName = newMemberName.trim();
      } else {
        setError("请选择成员或输入新成员名字");
        setBindLoading(false);
        return;
      }

      const res = await fetch("/api/wechat/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) {
        setBindingConn(null);
        loadStatus();
      } else {
        setError(data.error ?? "绑定失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败");
    } finally {
      setBindLoading(false);
    }
  }

  async function deleteConnection(connectionId: string) {
    try {
      await fetch(`/api/wechat/connections/${connectionId}`, { method: "DELETE" });
      loadStatus();
    } catch { /* ignore */ }
    setDeletingConn(null);
  }

  if (!status) return <div className="text-stone-400">加载中...</div>;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-stone-800">微信连接</h1>
          <p className="text-sm text-stone-500 mt-1">管理家庭成员的微信 ClawBot 连接</p>
        </div>
        {!pairing && (
          <button
            onClick={startPairing}
            disabled={!status.available}
            className="px-5 py-2.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            添加成员连接
          </button>
        )}
      </div>

      {!status.available && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
          <p className="text-sm text-amber-800 font-medium">微信通道未初始化</p>
          <p className="text-sm text-amber-600 mt-1">请确保 wechat-ilink-client 已安装并重启服务</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center justify-between">
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 text-sm">✕</button>
        </div>
      )}

      {/* QR Code pairing */}
      {pairing && (
        <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
          <h3 className="text-lg font-semibold text-stone-800 mb-2">扫码连接微信</h3>
          <p className="text-sm text-stone-500 mb-6">请用微信扫描下方二维码，扫码成功后将自动弹出成员绑定</p>

          {qrUrl ? (
            <div className="inline-block">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(qrUrl)}`}
                alt="WeChat QR Code"
                className="w-60 h-60 rounded-lg border border-stone-200"
              />
              <p className="text-xs text-stone-400 mt-3 break-all max-w-[240px] mx-auto">{qrUrl}</p>
            </div>
          ) : (
            <div className="w-60 h-60 mx-auto rounded-lg bg-stone-100 flex items-center justify-center">
              <p className="text-stone-400 text-sm">正在生成二维码...</p>
            </div>
          )}

          <div className="mt-6">
            <button
              onClick={cancelPairing}
              className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Bind Dialog */}
      {bindingConn && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setBindingConn(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-stone-800 mb-1">绑定家庭成员</h3>
            <p className="text-sm text-stone-500 mb-5">
              微信用户已连接，请将此连接绑定到一个家庭成员
            </p>

            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setBindMode("select")}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                  bindMode === "select" ? "bg-amber-50 text-amber-700 border border-amber-300" : "bg-stone-50 text-stone-500 border border-stone-200"
                }`}
              >
                选择已有成员
              </button>
              <button
                onClick={() => setBindMode("create")}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                  bindMode === "create" ? "bg-amber-50 text-amber-700 border border-amber-300" : "bg-stone-50 text-stone-500 border border-stone-200"
                }`}
              >
                新建成员
              </button>
            </div>

            {bindMode === "select" ? (
              <div className="space-y-2 max-h-60 overflow-auto">
                {members.length === 0 ? (
                  <p className="text-sm text-stone-400 text-center py-4">暂无成员，请新建</p>
                ) : (
                  members.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setSelectedMemberId(m.id)}
                      className={`w-full text-left p-3 rounded-lg border transition-colors flex items-center gap-3 ${
                        selectedMemberId === m.id
                          ? "border-amber-500 bg-amber-50"
                          : "border-stone-200 hover:border-stone-300"
                      }`}
                    >
                      <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 font-medium text-sm">
                        {m.name.charAt(0)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-stone-800">{m.name}</p>
                        <p className="text-xs text-stone-400">{m.role === "admin" ? "管理员" : "成员"}</p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            ) : (
              <input
                type="text"
                value={newMemberName}
                onChange={(e) => setNewMemberName(e.target.value)}
                placeholder="输入新成员名字"
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                autoFocus
              />
            )}

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setBindingConn(null)}
                className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 transition-colors"
              >
                取消
              </button>
              <button
                onClick={submitBind}
                disabled={bindLoading || (bindMode === "select" ? !selectedMemberId : !newMemberName.trim())}
                className="px-5 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
              >
                {bindLoading ? "绑定中..." : "确认绑定"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connections List */}
      <div className="bg-white rounded-xl border border-stone-200 p-6">
        <h3 className="text-sm font-medium text-stone-500 mb-4">连接列表</h3>

        {(!status.connections || status.connections.length === 0) ? (
          <p className="text-sm text-stone-400 py-8 text-center">
            暂无微信连接。点击上方「添加成员连接」开始配对。
          </p>
        ) : (
          <div className="space-y-3">
            {status.connections.map((conn) => {
              const s = STATUS_LABELS[conn.status] ?? STATUS_LABELS.disconnected!;
              return (
                <div key={conn.connectionId} className="flex items-center justify-between p-4 rounded-lg bg-stone-50">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center font-medium text-sm ${
                      conn.memberId ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                    }`}>
                      {conn.memberName ? conn.memberName.charAt(0) : "?"}
                    </div>
                    <div>
                      {conn.memberId ? (
                        <p className="text-sm font-medium text-stone-800">{conn.memberName}</p>
                      ) : (
                        <p className="text-sm font-medium text-amber-600">未绑定成员</p>
                      )}
                      <p className="text-xs text-stone-400">
                        {conn.wechatUserId ? `微信: ${conn.wechatUserId.slice(0, 16)}...` : conn.connectionId}
                      </p>
                      {conn.connectedAt && (
                        <p className="text-xs text-stone-400">连接于 {new Date(conn.connectedAt).toLocaleString("zh-CN")}</p>
                      )}
                      {conn.lastError && (
                        <p className="text-xs text-red-500 mt-0.5">{conn.lastError}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {!conn.memberId && (
                      <button
                        onClick={() => openBindDialog(conn)}
                        className="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-medium hover:bg-amber-600 transition-colors"
                      >
                        绑定成员
                      </button>
                    )}
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${s.bg}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                      {s.text}
                    </span>
                    <button
                      onClick={() => setDeletingConn(conn.connectionId)}
                      className="p-1.5 rounded-md text-stone-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                      title="删除连接"
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

      {/* Delete connection confirmation */}
      {deletingConn && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setDeletingConn(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-stone-800 mb-2">确认删除</h3>
            <p className="text-sm text-stone-500 mb-6">确定要删除此微信连接吗？删除后需要重新扫码配对。</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeletingConn(null)}
                className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => deleteConnection(deletingConn)}
                className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* How it works */}
      <div className="bg-stone-50 rounded-xl p-6">
        <h3 className="text-sm font-medium text-stone-700 mb-3">使用流程</h3>
        <ol className="space-y-2 text-sm text-stone-600">
          <li>1. 点击「添加成员连接」生成二维码</li>
          <li>2. 家庭成员用微信扫描二维码</li>
          <li>3. 扫码成功后，选择或新建家庭成员进行绑定</li>
          <li>4. 绑定完成后，该成员即可在微信中与管家对话</li>
          <li>5. 管家会根据成员的档案和习惯进行个性化回复</li>
        </ol>
      </div>
    </div>
  );
}
