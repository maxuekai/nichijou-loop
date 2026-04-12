import { useEffect, useState } from "react";
import { api } from "../../api";

interface PluginConfigField {
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
}

interface PluginTool {
  name: string;
  description: string;
}

interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  tools: PluginTool[];
  configSchema: Record<string, PluginConfigField> | null;
}

export function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [editingConfigFor, setEditingConfigFor] = useState<string | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({});
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    loadPlugins();
  }, []);

  async function loadPlugins() {
    setLoadError(null);
    try {
      const data = await api.getPlugins();
      setPlugins(data);
    } catch (e) {
      setPlugins([]);
      setLoadError(e instanceof Error ? e.message : "无法连接 API（请确认本机已运行 nichijou dev / start，默认端口 3000，与 Vite 代理一致）");
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (editingConfigFor === id) setEditingConfigFor(null);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function loadPluginConfig(pluginId: string) {
    setConfigError(null);
    try {
      const data = await api.getPluginConfig(pluginId);
      setConfigValues(data.config ?? {});
      setEditingConfigFor(pluginId);
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : "加载配置失败");
    }
  }

  async function savePluginConfig(pluginId: string) {
    setConfigSaving(true);
    setConfigSaved(false);
    setConfigError(null);
    try {
      await api.updatePluginConfig(pluginId, configValues);
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 2000);
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : "保存失败");
    }
    setConfigSaving(false);
  }

  function updateConfigField(key: string, value: unknown) {
    setConfigValues((prev) => ({ ...prev, [key]: value }));
  }

  function renderConfigField(key: string, field: PluginConfigField) {
    const value = configValues[key];

    if (field.type === "boolean") {
      return (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => updateConfigField(key, e.target.checked)}
            className="w-4 h-4 rounded border-stone-300 text-amber-500 focus:ring-amber-500/20"
          />
          <span className="text-sm text-stone-700">{field.description}</span>
        </label>
      );
    }

    if (field.type === "number") {
      return (
        <input
          type="number"
          value={value != null ? String(value) : ""}
          onChange={(e) => updateConfigField(key, e.target.value ? Number(e.target.value) : undefined)}
          placeholder={field.default != null ? String(field.default) : ""}
          className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
        />
      );
    }

    return (
      <input
        type="text"
        value={value != null ? String(value) : ""}
        onChange={(e) => updateConfigField(key, e.target.value || undefined)}
        placeholder={field.default != null ? String(field.default) : ""}
        className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-stone-800">插件管理</h1>
        <span className="text-sm text-stone-400">{loadError ? "—" : `${plugins.length} 个已注册`}</span>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
          <p className="font-medium">无法获取插件列表</p>
          <p className="mt-1 text-red-700/90">{loadError}</p>
          <p className="mt-2 text-xs text-red-600/80">
            若只运行了前端（Vite），请在另一终端执行 <code className="px-1 bg-red-100 rounded">pnpm nichijou dev</code> 或 <code className="px-1 bg-red-100 rounded">nichijou start</code> 启动后端。
          </p>
        </div>
      )}

      {!loadError && plugins.length === 0 && (
        <div className="bg-stone-50 border border-stone-200 rounded-xl p-8 text-center">
          <p className="text-sm text-stone-500">暂无已加载插件</p>
          <p className="text-xs text-stone-400 mt-2">
            在 <code className="px-1.5 py-0.5 bg-stone-200 rounded text-stone-600">~/.nichijou/config.yaml</code> 中配置{" "}
            <code className="px-1.5 py-0.5 bg-stone-200 rounded text-stone-600">plugins: [&quot;@nichijou/plugin-weather&quot;]</code>
            ，或使用 CLI 安装：
          </p>
          <p className="text-xs text-stone-400 mt-2">
            <code className="px-1.5 py-0.5 bg-stone-200 rounded text-stone-600">nichijou plugin install @nichijou/plugin-weather</code>
          </p>
          <p className="text-xs text-stone-400 mt-2">修改配置或安装后请重启服务。</p>
        </div>
      )}

      <div className="space-y-4">
        {plugins.map((plugin) => (
          <div key={plugin.id} className="bg-white rounded-xl border border-stone-200 overflow-hidden">
            <div
              className="flex items-center justify-between p-5 cursor-pointer hover:bg-stone-50/50 transition-colors"
              onClick={() => toggleExpand(plugin.id)}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center text-lg">
                  {plugin.id === "weather" ? "\u{1F326}" : "\u{1F9E9}"}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-stone-800">{plugin.name}</h3>
                    <span className="text-xs text-stone-400">v{plugin.version}</span>
                  </div>
                  <p className="text-xs text-stone-500 mt-0.5">{plugin.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-stone-400">{plugin.tools.length} 个工具</span>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  plugin.enabled ? "bg-green-50 text-green-700" : "bg-stone-100 text-stone-500"
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${plugin.enabled ? "bg-green-500" : "bg-stone-400"}`} />
                  {plugin.enabled ? "已启用" : "已禁用"}
                </span>
                <svg
                  className={`w-4 h-4 text-stone-400 transition-transform ${expanded.has(plugin.id) ? "rotate-180" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>

            {expanded.has(plugin.id) && (
              <div className="border-t border-stone-100 p-5 bg-stone-50/30">
                <h4 className="text-xs font-medium text-stone-500 mb-3">提供的工具</h4>
                <div className="space-y-2">
                  {plugin.tools.map((tool) => (
                    <div key={tool.name} className="flex items-start gap-2 p-3 rounded-lg bg-white border border-stone-100">
                      <span className="text-stone-400 mt-0.5">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      </span>
                      <div>
                        <p className="text-sm font-medium text-stone-700">{tool.name}</p>
                        <p className="text-xs text-stone-500 mt-0.5">{tool.description}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {plugin.configSchema && Object.keys(plugin.configSchema).length > 0 && (
                  <div className="mt-5 pt-5 border-t border-stone-200">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-xs font-medium text-stone-500">插件配置</h4>
                      {editingConfigFor !== plugin.id && (
                        <button
                          onClick={() => { void loadPluginConfig(plugin.id); }}
                          className="text-xs text-amber-600 hover:text-amber-700 cursor-pointer"
                        >
                          编辑配置
                        </button>
                      )}
                    </div>

                    {editingConfigFor === plugin.id && (
                      <div className="space-y-4">
                        {Object.entries(plugin.configSchema!).map(([key, field]) => (
                          <div key={key}>
                            <label className="block text-xs text-stone-600 mb-1">
                              {key}
                              {field.required && <span className="text-red-400 ml-0.5">*</span>}
                            </label>
                            <p className="text-xs text-stone-400 mb-1.5">{field.description}</p>
                            {renderConfigField(key, field)}
                          </div>
                        ))}

                        {configError && (
                          <p className="text-xs text-red-600">{configError}</p>
                        )}

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { void savePluginConfig(plugin.id); }}
                            disabled={configSaving}
                            className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors cursor-pointer"
                          >
                            {configSaving ? "保存中..." : configSaved ? "已保存" : "保存配置"}
                          </button>
                          <button
                            onClick={() => setEditingConfigFor(null)}
                            className="px-4 py-2 rounded-lg border border-stone-300 text-sm text-stone-600 hover:bg-stone-100 transition-colors cursor-pointer"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
