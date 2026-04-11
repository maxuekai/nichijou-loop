import { useEffect, useState } from "react";
import { api } from "../../api";

export function SoulEditor() {
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState(false);
  const [butlerAvatar, setButlerAvatar] = useState<string | null>(null);
  const [butlerName, setButlerName] = useState("Nichijou");
  const [editingButlerInfo, setEditingButlerInfo] = useState(false);
  const [butlerNameDraft, setButlerNameDraft] = useState("Nichijou");
  const [butlerAvatarFile, setButlerAvatarFile] = useState<File | null>(null);
  const [butlerAvatarPreview, setButlerAvatarPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSoul().then((data) => setContent(data.content));
    api.getConfig().then((cfg) => {
      const name = typeof cfg.butlerName === "string" ? cfg.butlerName.trim() : "";
      if (name) setButlerName(name);
    }).catch(() => { /* ignore */ });
    loadButlerAvatar();
  }, []);

  async function loadButlerAvatar() {
    try {
      const data = await api.getButlerAvatar();
      setButlerAvatar(data.avatar);
    } catch { /* ignore */ }
  }

  async function save() {
    try {
      setError(null);
      await api.updateConfig({ butlerName: butlerName.trim() || "Nichijou" });
      await api.updateSoul(content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败，请稍后重试");
    }
  }

  function openButlerEditDialog() {
    setButlerNameDraft(butlerName || "Nichijou");
    setButlerAvatarFile(null);
    setButlerAvatarPreview(butlerAvatar ? api.avatarUrl(butlerAvatar) : null);
    setEditingButlerInfo(true);
  }

  async function saveButlerInfo() {
    try {
      setError(null);
      const nextName = butlerNameDraft.trim() || "Nichijou";
      if (butlerAvatarFile) {
        await api.uploadButlerAvatar(butlerAvatarFile);
        await loadButlerAvatar();
      }
      await api.updateConfig({ butlerName: nextName });
      setButlerName(nextName);
      setEditingButlerInfo(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存管家信息失败");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-stone-800">管家</h1>
          <p className="text-sm text-stone-500 mt-1">管理管家形象与人格设定</p>
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="text-sm text-green-600">已保存</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
          <button
            onClick={save}
            className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
          >
            保存
          </button>
        </div>
      </div>

      {/* Butler avatar */}
      <div className="bg-white rounded-xl border border-stone-200 p-6">
        <h3 className="text-sm font-medium text-stone-500 mb-4">管家信息</h3>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            {butlerAvatar ? (
              <img src={api.avatarUrl(butlerAvatar)} alt={butlerName || "管家"} className="w-16 h-16 rounded-full object-cover" />
            ) : (
              <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 text-xl font-medium">
                {(butlerName || "N").charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-base font-semibold text-stone-800 truncate">{butlerName}</p>
              <p className="text-xs text-stone-400 mt-0.5">点击编辑可修改名称与头像</p>
            </div>
          </div>
          <button
            onClick={openButlerEditDialog}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors"
          >
            编辑
          </button>
        </div>
      </div>

      {/* Soul editor */}
      <div className="bg-white rounded-xl border border-stone-200 p-6">
        <h3 className="text-sm font-medium text-stone-500 mb-4">人格设定 · SOUL.md</h3>
        <p className="text-xs text-stone-400 mb-3">定义管家的性格、语气和偏好，影响 AI 的回复风格</p>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={20}
          className="w-full px-4 py-3 rounded-lg border border-stone-200 bg-stone-50 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 resize-none"
        />
      </div>

      {editingButlerInfo && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setEditingButlerInfo(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-stone-800 mb-4">编辑管家信息</h3>
            <div className="space-y-4">
              <div className="flex justify-center">
                <label className="relative cursor-pointer group">
                  {butlerAvatarPreview ? (
                    <img src={butlerAvatarPreview} alt={butlerNameDraft || "管家"} className="w-20 h-20 rounded-full object-cover" />
                  ) : (
                    <div className="w-20 h-20 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 text-2xl font-medium">
                      {(butlerNameDraft || "N").charAt(0).toUpperCase()}
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
                      setButlerAvatarFile(file);
                      setButlerAvatarPreview(URL.createObjectURL(file));
                    }}
                  />
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">管家名称</label>
                <input
                  type="text"
                  value={butlerNameDraft}
                  onChange={(e) => setButlerNameDraft(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setEditingButlerInfo(false)}
                className="px-4 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 transition-colors"
              >
                取消
              </button>
              <button
                onClick={saveButlerInfo}
                className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600"
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
