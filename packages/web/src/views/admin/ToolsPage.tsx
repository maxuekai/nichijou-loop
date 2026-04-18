import { useEffect, useState } from "react";
import { api } from "../../api";
import {
  WrenchScrewdriverIcon,
  ChevronDownIcon,
} from "@heroicons/react/24/outline";
import { createIconWrapper } from "../../components/ui/Icon";

// 创建包装过的图标组件
const ToolIcon = createIconWrapper(WrenchScrewdriverIcon);
const ChevronIcon = createIconWrapper(ChevronDownIcon);

interface ToolParam {
  type?: string;
  description?: string;
  enum?: string[];
}

interface ToolInfo {
  source: string;
  name: string;
  description: string;
  parameters: {
    type?: string;
    properties?: Record<string, ToolParam>;
    required?: string[];
  };
}

export function ToolsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<{ content: string; isError?: boolean } | null>(null);

  useEffect(() => {
    loadTools();
  }, []);

  async function loadTools() {
    setLoadError(null);
    try {
      const data = await api.getAllTools();
      setTools(data as ToolInfo[]);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载工具列表失败");
    }
  }

  function toggleTool(name: string) {
    if (expandedTool === name) {
      setExpandedTool(null);
    } else {
      setExpandedTool(name);
      setParamValues({});
      setResult(null);
    }
  }

  async function handleExecute(tool: ToolInfo) {
    setExecuting(true);
    setResult(null);
    try {
      const params: Record<string, unknown> = {};
      const props = tool.parameters.properties ?? {};
      for (const [key, schema] of Object.entries(props)) {
        const raw = paramValues[key];
        if (raw === undefined || raw === "") continue;
        if (schema.type === "number") {
          params[key] = Number(raw);
        } else if (schema.type === "boolean") {
          params[key] = raw === "true";
        } else {
          params[key] = raw;
        }
      }
      const res = await api.executeTool(tool.name, params);
      setResult(res);
    } catch (e) {
      setResult({ content: e instanceof Error ? e.message : "执行失败", isError: true });
    } finally {
      setExecuting(false);
    }
  }

  const grouped = new Map<string, ToolInfo[]>();
  for (const t of tools) {
    const group = grouped.get(t.source) ?? [];
    group.push(t);
    grouped.set(t.source, group);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-stone-800">工具管理</h1>
        <span className="text-sm text-stone-400">{tools.length} 个可用工具</span>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">{loadError}</div>
      )}

      {[...grouped.entries()].map(([source, groupTools]) => (
        <div key={source} className="space-y-2">
          <h2 className="text-sm font-semibold text-stone-500 px-1">
            {source === "core" ? "内置工具" : source.replace("plugin:", "插件: ")}
            <span className="ml-2 text-xs font-normal text-stone-400">{groupTools.length} 个</span>
          </h2>

          <div className="space-y-2">
            {groupTools.map((tool) => {
              const isExpanded = expandedTool === tool.name;
              const props = tool.parameters.properties ?? {};
              const required = tool.parameters.required ?? [];
              const paramKeys = Object.keys(props);

              return (
                <div
                  key={tool.name}
                  className="bg-white rounded-xl border border-stone-200 overflow-hidden"
                >
                  <div
                    className="flex items-center justify-between p-4 cursor-pointer hover:bg-stone-50/50 transition-colors"
                    onClick={() => toggleTool(tool.name)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                        <ToolIcon size="md" className="text-blue-500" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-stone-800 font-mono">{tool.name}</p>
                        <p className="text-xs text-stone-500 mt-0.5 truncate">{tool.description}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-4">
                      {paramKeys.length > 0 && (
                        <span className="text-[10px] text-stone-400 bg-stone-100 px-1.5 py-0.5 rounded">
                          {paramKeys.length} 参数
                        </span>
                      )}
                      <ChevronIcon 
                        size="md"
                        className={`text-stone-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      />
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-stone-100 p-4 bg-stone-50/30 space-y-4">
                      {paramKeys.length > 0 ? (
                        <div className="space-y-3">
                          <p className="text-xs font-medium text-stone-500">参数</p>
                          {paramKeys.map((key) => {
                            const schema = props[key]!;
                            const isRequired = required.includes(key);
                            return (
                              <div key={key}>
                                <label className="flex items-center gap-1.5 text-xs text-stone-700 mb-1">
                                  <span className="font-mono font-medium">{key}</span>
                                  {isRequired && <span className="text-red-400">*</span>}
                                  <span className="text-stone-400">({schema.type ?? "string"})</span>
                                </label>
                                {schema.description && (
                                  <p className="text-[11px] text-stone-400 mb-1.5">{schema.description}</p>
                                )}
                                {schema.type === "boolean" ? (
                                  <select
                                    value={paramValues[key] ?? ""}
                                    onChange={(e) => setParamValues({ ...paramValues, [key]: e.target.value })}
                                    className="w-full px-3 py-2 rounded-lg border border-stone-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
                                  >
                                    <option value="">--</option>
                                    <option value="true">true</option>
                                    <option value="false">false</option>
                                  </select>
                                ) : schema.enum ? (
                                  <select
                                    value={paramValues[key] ?? ""}
                                    onChange={(e) => setParamValues({ ...paramValues, [key]: e.target.value })}
                                    className="w-full px-3 py-2 rounded-lg border border-stone-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
                                  >
                                    <option value="">--</option>
                                    {schema.enum.map((v) => (
                                      <option key={v} value={v}>{v}</option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    type={schema.type === "number" ? "number" : "text"}
                                    value={paramValues[key] ?? ""}
                                    onChange={(e) => setParamValues({ ...paramValues, [key]: e.target.value })}
                                    placeholder={isRequired ? "必填" : "可选"}
                                    className="w-full px-3 py-2 rounded-lg border border-stone-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-stone-400">此工具无需参数</p>
                      )}

                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => { void handleExecute(tool); }}
                          disabled={executing}
                          className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {executing ? "执行中..." : "调试执行"}
                        </button>
                        {result && (
                          <span className={`text-xs ${result.isError ? "text-red-500" : "text-green-600"}`}>
                            {result.isError ? "执行出错" : "执行成功"}
                          </span>
                        )}
                      </div>

                      {result && (
                        <div className={`rounded-lg border p-3 text-sm font-mono whitespace-pre-wrap break-all ${
                          result.isError
                            ? "bg-red-50 border-red-200 text-red-800"
                            : "bg-green-50 border-green-200 text-green-800"
                        }`}>
                          {result.content}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {!loadError && tools.length === 0 && (
        <div className="text-center text-stone-400 py-12">暂无可用工具</div>
      )}
    </div>
  );
}
