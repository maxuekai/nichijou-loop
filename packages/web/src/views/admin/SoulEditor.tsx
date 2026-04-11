import { useEffect, useState } from "react";
import { api } from "../../api";

export function SoulEditor() {
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState(false);
  const [butlerAvatar, setButlerAvatar] = useState<string | null>(null);

  useEffect(() => {
    api.getSoul().then((data) => setContent(data.content));
    loadButlerAvatar();
  }, []);

  async function loadButlerAvatar() {
    try {
      const data = await api.getButlerAvatar();
      setButlerAvatar(data.avatar);
    } catch { /* ignore */ }
  }

  async function save() {
    await api.updateSoul(content);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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
        <h3 className="text-sm font-medium text-stone-500 mb-4">管家头像</h3>
        <div className="flex items-center gap-5">
          <label className="relative cursor-pointer group">
            {butlerAvatar ? (
              <img src={api.avatarUrl(butlerAvatar)} alt="管家" className="w-20 h-20 rounded-full object-cover" />
            ) : (
              <div className="w-20 h-20 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 text-2xl font-medium">
                N
              </div>
            )}
            <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                await api.uploadButlerAvatar(file);
                loadButlerAvatar();
              }}
            />
          </label>
          <div className="text-sm text-stone-500">
            <p>点击头像上传或更换</p>
            <p className="text-xs text-stone-400 mt-1">支持 JPG、PNG、GIF、WebP 格式</p>
          </div>
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
    </div>
  );
}
