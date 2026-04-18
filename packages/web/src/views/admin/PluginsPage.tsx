import { useEffect, useState, useCallback } from "react";
import { api } from "../../api";
import {
  ChevronDownIcon,
  CogIcon,
} from "@heroicons/react/24/outline";
import { createIconWrapper } from "../../components/ui/Icon";

// 创建包装过的图标组件
const ChevronIcon = createIconWrapper(ChevronDownIcon);
const ToolIcon = createIconWrapper(CogIcon);

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

const SENSITIVE_KEYS = /key|secret|token|password/i;

function maskValue(key: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "未配置";
  const str = String(value);
  if (SENSITIVE_KEYS.test(key) && str.length > 4) {
    return str.slice(0, 4) + "****" + str.slice(-4);
  }
  return str;
}

export function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [editingConfigFor, setEditingConfigFor] = useState<string | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({});
  const [savedConfigs, setSavedConfigs] = useState<Record<string, Record<string, unknown>>>({});
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

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

  const loadSavedConfig = useCallback(async (pluginId: string) => {
    try {
      const data = await api.getPluginConfig(pluginId);
      setSavedConfigs((prev) => ({ ...prev, [pluginId]: data.config ?? {} }));
    } catch { /* ignore */ }
  }, []);

  async function togglePluginEnabled(pluginId: string, enabled: boolean) {
    setToggling(pluginId);
    setToggleError(null);
    try {
      const res = await api.setPluginEnabled(pluginId, enabled);
      if (!res.ok) {
        setToggleError(res.error ?? "操作失败");
      } else {
        await loadPlugins();
      }
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : "操作失败");
    }
    setToggling(null);
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (editingConfigFor === id) setEditingConfigFor(null);
      } else {
        next.add(id);
        void loadSavedConfig(id);
      }
      return next;
    });
  }

  function startEditConfig(pluginId: string) {
    const saved = savedConfigs[pluginId] ?? {};
    setConfigValues({ ...saved });
    setConfigError(null);
    setEditingConfigFor(pluginId);
  }

  async function savePluginConfig(pluginId: string) {
    setConfigSaving(true);
    setConfigError(null);
    try {
      await api.updatePluginConfig(pluginId, configValues);
      setSavedConfigs((prev) => ({ ...prev, [pluginId]: { ...configValues } }));
      setEditingConfigFor(null);
      await loadPlugins();
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
        {plugins.map((plugin) => {
          const isEditing = editingConfigFor === plugin.id;
          const hasConfig = plugin.configSchema && Object.keys(plugin.configSchema).length > 0;
          const currentSaved = savedConfigs[plugin.id] ?? {};

          return (
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
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void togglePluginEnabled(plugin.id, !plugin.enabled);
                    }}
                    disabled={toggling === plugin.id}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                      plugin.enabled ? "bg-green-500" : "bg-stone-300"
                    } ${toggling === plugin.id ? "opacity-50" : "cursor-pointer"}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                      plugin.enabled ? "translate-x-4" : "translate-x-0.5"
                    }`} />
                  </button>
                  <ChevronIcon 
                    size="md"
                    className={`text-stone-400 transition-transform ${expanded.has(plugin.id) ? "rotate-180" : ""}`}
                  />
                </div>
              </div>

              {expanded.has(plugin.id) && (
                <div className="border-t border-stone-100 p-5 bg-stone-50/30">
                  {toggleError && toggling === null && (
                    <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                      {toggleError}
                      <button onClick={() => setToggleError(null)} className="ml-2 underline cursor-pointer">关闭</button>
                    </div>
                  )}
                  <h4 className="text-xs font-medium text-stone-500 mb-3">提供的工具</h4>
                  <div className="space-y-2">
                    {plugin.tools.map((tool) => (
                      <div key={tool.name} className="flex items-start gap-2 p-3 rounded-lg bg-white border border-stone-100">
                        <span className="text-stone-400 mt-0.5">
                          <ToolIcon size="md" />
                        </span>
                        <div>
                          <p className="text-sm font-medium text-stone-700">{tool.name}</p>
                          <p className="text-xs text-stone-500 mt-0.5">{tool.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  {hasConfig && (
                    <div className="mt-5 pt-5 border-t border-stone-200">
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-xs font-medium text-stone-500">插件配置</h4>
                        {!isEditing && (
                          <button
                            onClick={() => startEditConfig(plugin.id)}
                            className="text-xs text-amber-600 hover:text-amber-700 cursor-pointer"
                          >
                            编辑配置
                          </button>
                        )}
                      </div>

                      {isEditing ? (
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
                              {configSaving ? "保存中..." : "保存配置"}
                            </button>
                            <button
                              onClick={() => setEditingConfigFor(null)}
                              className="px-4 py-2 rounded-lg border border-stone-300 text-sm text-stone-600 hover:bg-stone-100 transition-colors cursor-pointer"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {Object.entries(plugin.configSchema!).map(([key, field]) => {
                            const val = currentSaved[key];
                            const isEmpty = val === undefined || val === null || val === "";
                            return (
                              <div key={key} className="flex items-start justify-between gap-4 py-2 px-3 rounded-lg bg-white border border-stone-100">
                                <div className="min-w-0">
                                  <p className="text-xs font-medium text-stone-600">
                                    {key}
                                    {field.required && <span className="text-red-400 ml-0.5">*</span>}
                                  </p>
                                  <p className="text-[11px] text-stone-400 mt-0.5">{field.description}</p>
                                </div>
                                <span className={`text-xs font-mono shrink-0 mt-0.5 ${isEmpty ? "text-stone-300 italic" : "text-stone-600"}`}>
                                  {field.type === "boolean"
                                    ? (val ? "true" : "false")
                                    : maskValue(key, val)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
