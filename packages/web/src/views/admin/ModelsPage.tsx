import { useEffect, useState, useCallback } from "react";
import { api } from "../../api";
import {
  ChevronDownIcon,
  CpuChipIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  PlayIcon,
  CheckIcon,
  XMarkIcon,
  CloudIcon,
  ComputerDesktopIcon,
} from "@heroicons/react/24/outline";
import { createIconWrapper } from "../../components/ui/Icon";
import { Select } from "../../components/ui/Select";

// 创建包装过的图标组件
const ChevronIcon = createIconWrapper(ChevronDownIcon);
const ModelIcon = createIconWrapper(CpuChipIcon);
const AddIcon = createIconWrapper(PlusIcon);
const DeleteIcon = createIconWrapper(TrashIcon);
const EditIcon = createIconWrapper(PencilIcon);
const TestIcon = createIconWrapper(PlayIcon);
const SaveIcon = createIconWrapper(CheckIcon);
const CancelIcon = createIconWrapper(XMarkIcon);
const CloudServiceIcon = createIconWrapper(CloudIcon);
const LocalServiceIcon = createIconWrapper(ComputerDesktopIcon);

interface LLMModelConfig {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeout?: number;
  thinkingMode?: boolean;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

// 模型预设
const MODEL_PRESETS = [
  { 
    name: "OpenAI", 
    provider: "openai",
    baseUrl: "https://api.openai.com/v1", 
    model: "gpt-4o", 
    needsKey: true 
  },
  { 
    name: "Anthropic", 
    provider: "anthropic", 
    baseUrl: "https://api.anthropic.com/v1", 
    model: "claude-sonnet-4-20250514", 
    needsKey: true 
  },
  { 
    name: "DeepSeek", 
    provider: "deepseek", 
    baseUrl: "https://api.deepseek.com/v1", 
    model: "deepseek-chat", 
    needsKey: true 
  },
  { 
    name: "豆包", 
    provider: "doubao", 
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3", 
    model: "doubao-pro-32k", 
    needsKey: true 
  },
  { 
    name: "Kimi", 
    provider: "kimi",
    baseUrl: "https://api.moonshot.cn/v1", 
    model: "moonshot-v1-8k", 
    needsKey: true 
  },
  { 
    name: "Minimax", 
    provider: "minimax", 
    baseUrl: "https://api.minimax.chat/v1", 
    model: "abab6.5-chat", 
    needsKey: true 
  },
  { 
    name: "Ollama (本地)", 
    provider: "ollama", 
    baseUrl: "http://localhost:11434/v1", 
    model: "qwen2.5", 
    needsKey: false 
  },
  { 
    name: "LM Studio (本地)", 
    provider: "lm-studio", 
    baseUrl: "http://localhost:1234/v1", 
    model: "default", 
    needsKey: false 
  },
];

function maskApiKey(key: string): string {
  if (!key) return "未配置";
  if (key === "***") return "已配置";
  if (key.length <= 8) return key;
  return key.slice(0, 4) + "****" + key.slice(-4);
}

function getProviderIcon(provider: string) {
  const isLocal = provider === "ollama" || provider === "lm-studio";
  return isLocal ? LocalServiceIcon : CloudServiceIcon;
}

export function ModelsPage() {
  const [models, setModels] = useState<LLMModelConfig[]>([]);
  const [activeModelId, setActiveModelId] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 添加模型相关状态
  const [isAddingModel, setIsAddingModel] = useState(false);
  const [newModelData, setNewModelData] = useState({
    name: "",
    provider: "",
    baseUrl: "",
    apiKey: "",
    model: "",
    timeout: 30000,
    thinkingMode: false,
    enabled: true,
    isDefault: false,
  });
  const [selectedPreset, setSelectedPreset] = useState<string>("");

  // 编辑模型相关状态
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [editingData, setEditingData] = useState<Partial<LLMModelConfig>>({});

  // 操作状态
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; error?: string }>>({});
  const [deleting, setDeleting] = useState<string | null>(null);
  const [activating, setActivating] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    loadModels();
  }, []);

  async function loadModels() {
    setLoadError(null);
    try {
      const data = await api.getModels();
      setModels(data.models);
      setActiveModelId(data.activeModelId);
    } catch (e) {
      console.error("[ModelsPage] Error loading models:", e);
      setModels([]);
      setLoadError(e instanceof Error ? e.message : "无法获取模型列表");
    }
  }

  function toggleExpand(modelId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
        if (editingModelId === modelId) setEditingModelId(null);
      } else {
        next.add(modelId);
      }
      return next;
    });
  }

  function handlePresetChange(presetName: string) {
    setSelectedPreset(presetName);
    const preset = MODEL_PRESETS.find(p => p.name === presetName);
    if (preset) {
      setNewModelData(prev => ({
        ...prev,
        name: preset.name,
        provider: preset.provider,
        baseUrl: preset.baseUrl,
        model: preset.model,
        apiKey: prev.apiKey, // 保留已输入的 API Key
        thinkingMode: false,
      }));
    }
  }

  async function handleAddModel() {
    setSaving(true);
    setActionError(null);
    try {
      await api.addModel(newModelData);
      await loadModels();
      setIsAddingModel(false);
      setNewModelData({
        name: "",
        provider: "",
        baseUrl: "",
        apiKey: "",
        model: "",
        timeout: 30000,
        thinkingMode: false,
        enabled: true,
        isDefault: false,
      });
      setSelectedPreset("");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "添加模型失败");
    }
    setSaving(false);
  }

  function startEditModel(model: LLMModelConfig) {
    setEditingModelId(model.id);
    setEditingData({ ...model });
    setActionError(null);
  }

  async function handleUpdateModel() {
    if (!editingModelId) return;
    setSaving(true);
    setActionError(null);
    try {
      // 处理 API key：如果是 "***" 或为空，则不更新此字段
      const updateData = { ...editingData };
      if (!updateData.apiKey || updateData.apiKey === "***") {
        delete updateData.apiKey;
      }
      
      await api.updateModel(editingModelId, updateData);
      await loadModels();
      setEditingModelId(null);
      setEditingData({});
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "更新模型失败");
    }
    setSaving(false);
  }

  async function handleDeleteModel(modelId: string) {
    if (!confirm("确定要删除此模型吗？此操作不可撤销。")) return;
    
    setDeleting(modelId);
    setActionError(null);
    try {
      await api.deleteModel(modelId);
      await loadModels();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "删除模型失败");
    }
    setDeleting(null);
  }

  async function handleTestModel(model: LLMModelConfig) {
    setTesting(model.id);
    setActionError(null);
    try {
      const result = await api.testModel(model);
      setTestResults(prev => ({ ...prev, [model.id]: result }));
    } catch (e) {
      setTestResults(prev => ({ 
        ...prev, 
        [model.id]: { 
          success: false, 
          error: e instanceof Error ? e.message : "测试失败" 
        } 
      }));
    }
    setTesting(null);
  }

  async function handleActivateModel(modelId: string) {
    setActivating(modelId);
    setActionError(null);
    try {
      await api.activateModel(modelId);
      await loadModels();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "激活模型失败");
    }
    setActivating(null);
  }

  function cancelEdit() {
    setEditingModelId(null);
    setEditingData({});
    setActionError(null);
  }

  function cancelAdd() {
    setIsAddingModel(false);
    setNewModelData({
      name: "",
      provider: "",
      baseUrl: "",
      apiKey: "",
      model: "",
      timeout: 30000,
      thinkingMode: false,
      enabled: true,
      isDefault: false,
    });
    setSelectedPreset("");
    setActionError(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-stone-800">模型管理</h1>
        <div className="flex items-center gap-3">
          {!loadError && (
            <span className="text-sm text-stone-400">
              {`${models.length} 个模型`}
            </span>
          )}
          <button
            onClick={() => setIsAddingModel(true)}
            disabled={isAddingModel}
            className="flex items-center gap-2 px-3 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <AddIcon size="sm" />
            添加模型
          </button>
        </div>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
          <p className="font-medium">无法获取模型列表</p>
          <p className="mt-1 text-red-700/90">{loadError}</p>
        </div>
      )}

      {actionError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
          <div className="flex items-center justify-between">
            <p>{actionError}</p>
            <button onClick={() => setActionError(null)} className="text-red-600 hover:text-red-800">
              <CancelIcon size="sm" />
            </button>
          </div>
        </div>
      )}

      {/* 添加模型表单 */}
      {isAddingModel && (
        <div className="bg-white rounded-xl border border-stone-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-stone-800">添加新模型</h3>
            <button onClick={cancelAdd} className="text-stone-400 hover:text-stone-600">
              <CancelIcon size="md" />
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">选择预设</label>
              <Select
                value={selectedPreset}
                onChange={handlePresetChange}
                className="w-full"
                options={[
                  { value: "", label: "自定义配置" },
                  ...MODEL_PRESETS.map((preset) => ({
                    value: preset.name,
                    label: `${preset.name} ${preset.needsKey ? "(需要API Key)" : "(本地)"}`,
                  })),
                ]}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-2">显示名称</label>
                <input
                  type="text"
                  value={newModelData.name}
                  onChange={(e) => setNewModelData(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  placeholder="例如：OpenAI GPT-4o"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-2">厂商标识</label>
                <input
                  type="text"
                  value={newModelData.provider}
                  onChange={(e) => setNewModelData(prev => ({ ...prev, provider: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  placeholder="例如：openai"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">API端点</label>
              <input
                type="url"
                value={newModelData.baseUrl}
                onChange={(e) => setNewModelData(prev => ({ ...prev, baseUrl: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                placeholder="例如：https://api.openai.com/v1"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">API密钥</label>
              <input
                type="password"
                value={newModelData.apiKey}
                onChange={(e) => setNewModelData(prev => ({ ...prev, apiKey: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                placeholder="输入API Key（本地模型可留空）"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-2">模型名称</label>
                <input
                  type="text"
                  value={newModelData.model}
                  onChange={(e) => setNewModelData(prev => ({ ...prev, model: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  placeholder="例如：gpt-4o"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-2">超时时间(毫秒)</label>
                <input
                  type="number"
                  value={newModelData.timeout}
                  onChange={(e) => setNewModelData(prev => ({ ...prev, timeout: parseInt(e.target.value) || 30000 }))}
                  className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  placeholder="30000"
                />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newModelData.enabled}
                  onChange={(e) => setNewModelData(prev => ({ ...prev, enabled: e.target.checked }))}
                  className="w-4 h-4 text-amber-600 border-stone-300 rounded focus:ring-amber-500"
                />
                <span className="text-sm text-stone-700">启用此模型</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newModelData.isDefault}
                  onChange={(e) => setNewModelData(prev => ({ ...prev, isDefault: e.target.checked }))}
                  className="w-4 h-4 text-amber-600 border-stone-300 rounded focus:ring-amber-500"
                />
                <span className="text-sm text-stone-700">设为默认模型</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newModelData.thinkingMode}
                  onChange={(e) => setNewModelData(prev => ({ ...prev, thinkingMode: e.target.checked }))}
                  className="w-4 h-4 text-amber-600 border-stone-300 rounded focus:ring-amber-500"
                />
                <span className="text-sm text-stone-700">思考模式</span>
              </label>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-stone-100">
              <button
                onClick={cancelAdd}
                disabled={saving}
                className="px-4 py-2 text-stone-600 border border-stone-300 rounded-lg hover:bg-stone-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleAddModel}
                disabled={saving || !newModelData.name || !newModelData.baseUrl || !newModelData.model}
                className="flex items-center gap-2 px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving && <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />}
                <SaveIcon size="sm" />
                添加模型
              </button>
            </div>
          </div>
        </div>
      )}

      {!loadError && models.length === 0 && (
        <div className="bg-stone-50 border border-stone-200 rounded-xl p-8 text-center">
          <p className="text-sm text-stone-500">暂无配置的模型</p>
          <p className="text-xs text-stone-400 mt-2">
            点击"添加模型"按钮来配置第一个AI模型
          </p>
        </div>
      )}

      <div className="space-y-4">
        {models.map((model) => {
          const isActive = model.id === activeModelId;
          const isEditing = editingModelId === model.id;
          const testResult = testResults[model.id];
          const ProviderIcon = getProviderIcon(model.provider);
          const displayName = model.name.trim();
          const shouldShowDisplayName = displayName && displayName !== model.model && displayName !== "默认模型";

          return (
            <div key={model.id} className="bg-white rounded-xl border border-stone-200 overflow-hidden">
              <div
                className="flex items-center justify-between p-5 cursor-pointer hover:bg-stone-50/50 transition-colors"
                onClick={() => toggleExpand(model.id)}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-lg ${
                    isActive ? "bg-green-100" : "bg-amber-50"
                  }`}>
                    <ProviderIcon size="md" className={isActive ? "text-green-600" : "text-amber-600"} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="text-sm font-semibold text-stone-800 truncate">{model.model}</h3>
                      {isActive && (
                        <span className="shrink-0 px-2 py-0.5 text-xs bg-green-100 text-green-800 rounded-full">默认模型</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 min-w-0">
                      {shouldShowDisplayName && (
                        <>
                          <p className="text-xs text-stone-500 truncate">{displayName}</p>
                          <span className="shrink-0 text-xs text-stone-400">•</span>
                        </>
                      )}
                      <p className="text-xs text-stone-400 truncate">{model.baseUrl}</p>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`px-2 py-1 text-xs rounded-full ${
                    model.enabled 
                      ? "bg-green-100 text-green-800" 
                      : "bg-red-100 text-red-800"
                  }`}>
                    {model.enabled ? "已启用" : "已禁用"}
                  </span>
                  <ChevronIcon 
                    size="md"
                    className={`text-stone-400 transition-transform ${expanded.has(model.id) ? "rotate-180" : ""}`}
                  />
                </div>
              </div>

              {expanded.has(model.id) && (
                <div className="border-t border-stone-100 p-5 bg-stone-50/30">
                  {/* 模型详细信息 */}
                  {!isEditing ? (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <h4 className="text-xs font-medium text-stone-500 mb-1">API端点</h4>
                          <p className="text-sm text-stone-800 font-mono bg-stone-100 px-2 py-1 rounded truncate">{model.baseUrl}</p>
                        </div>
                        <div>
                          <h4 className="text-xs font-medium text-stone-500 mb-1">API密钥</h4>
                          <p className="text-sm text-stone-800 font-mono bg-stone-100 px-2 py-1 rounded">{maskApiKey(model.apiKey)}</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-4 gap-4">
                        <div>
                          <h4 className="text-xs font-medium text-stone-500 mb-1">模型名称</h4>
                          <p className="text-sm text-stone-800 font-mono bg-stone-100 px-2 py-1 rounded">{model.model}</p>
                        </div>
                        <div>
                          <h4 className="text-xs font-medium text-stone-500 mb-1">超时时间</h4>
                          <p className="text-sm text-stone-800 bg-stone-100 px-2 py-1 rounded">
                            {model.timeout ? `${model.timeout}ms` : "默认"}
                          </p>
                        </div>
                        <div>
                          <h4 className="text-xs font-medium text-stone-500 mb-1">创建时间</h4>
                          <p className="text-sm text-stone-800 bg-stone-100 px-2 py-1 rounded">
                            {new Date(model.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div>
                          <h4 className="text-xs font-medium text-stone-500 mb-1">思考模式</h4>
                          <p className="text-sm text-stone-800 bg-stone-100 px-2 py-1 rounded">
                            {model.thinkingMode ? "开启" : "关闭"}
                          </p>
                        </div>
                      </div>

                      {testResult && (
                        <div className={`p-3 rounded-lg text-sm ${
                          testResult.success 
                            ? "bg-green-50 border border-green-200 text-green-800" 
                            : "bg-red-50 border border-red-200 text-red-800"
                        }`}>
                          {testResult.success ? "✅ 连接测试成功" : `❌ 连接测试失败：${testResult.error}`}
                        </div>
                      )}

                      <div className="flex items-center justify-between pt-2 border-t border-stone-200">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTestModel(model);
                            }}
                            disabled={testing === model.id}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-50"
                          >
                            {testing === model.id ? (
                              <div className="w-3 h-3 border border-blue-600 border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <TestIcon size="sm" />
                            )}
                            测试连接
                          </button>

                          {!isActive && model.enabled && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleActivateModel(model.id);
                              }}
                              disabled={activating === model.id}
                              className="flex items-center gap-2 px-3 py-1.5 text-sm text-green-600 border border-green-300 rounded-lg hover:bg-green-50 transition-colors disabled:opacity-50"
                            >
                              {activating === model.id && (
                                <div className="w-3 h-3 border border-green-600 border-t-transparent rounded-full animate-spin" />
                              )}
                              激活为默认
                            </button>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditModel(model);
                            }}
                            className="flex items-center gap-1 px-2 py-1 text-xs text-stone-600 hover:text-stone-800 hover:bg-stone-100 rounded transition-colors"
                          >
                            <EditIcon size="sm" />
                            编辑
                          </button>
                          {!isActive && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteModel(model.id);
                              }}
                              disabled={deleting === model.id}
                              className="flex items-center gap-1 px-2 py-1 text-xs text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                            >
                              {deleting === model.id ? (
                                <div className="w-3 h-3 border border-red-600 border-t-transparent rounded-full animate-spin" />
                              ) : (
                                <DeleteIcon size="sm" />
                              )}
                              删除
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* 编辑表单 */
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-stone-700 mb-2">显示名称</label>
                          <input
                            type="text"
                            value={editingData.name || ""}
                            onChange={(e) => setEditingData(prev => ({ ...prev, name: e.target.value }))}
                            className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-stone-700 mb-2">厂商标识</label>
                          <input
                            type="text"
                            value={editingData.provider || ""}
                            onChange={(e) => setEditingData(prev => ({ ...prev, provider: e.target.value }))}
                            className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-stone-700 mb-2">API端点</label>
                        <input
                          type="url"
                          value={editingData.baseUrl || ""}
                          onChange={(e) => setEditingData(prev => ({ ...prev, baseUrl: e.target.value }))}
                          className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-stone-700 mb-2">API密钥</label>
                        <input
                          type="password"
                          value={editingData.apiKey === "***" ? "" : (editingData.apiKey || "")}
                          onChange={(e) => setEditingData(prev => ({ ...prev, apiKey: e.target.value }))}
                          placeholder="留空保持原有密钥不变"
                          className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-stone-700 mb-2">模型名称</label>
                          <input
                            type="text"
                            value={editingData.model || ""}
                            onChange={(e) => setEditingData(prev => ({ ...prev, model: e.target.value }))}
                            className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-stone-700 mb-2">超时时间(毫秒)</label>
                          <input
                            type="number"
                            value={editingData.timeout || ""}
                            onChange={(e) => setEditingData(prev => ({ ...prev, timeout: parseInt(e.target.value) || undefined }))}
                            className="w-full px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                          />
                        </div>
                      </div>

                      <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editingData.enabled ?? false}
                            onChange={(e) => setEditingData(prev => ({ ...prev, enabled: e.target.checked }))}
                            className="w-4 h-4 text-amber-600 border-stone-300 rounded focus:ring-amber-500"
                          />
                          <span className="text-sm text-stone-700">启用此模型</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editingData.isDefault ?? false}
                            onChange={(e) => setEditingData(prev => ({ ...prev, isDefault: e.target.checked }))}
                            className="w-4 h-4 text-amber-600 border-stone-300 rounded focus:ring-amber-500"
                          />
                          <span className="text-sm text-stone-700">设为默认模型</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editingData.thinkingMode ?? false}
                            onChange={(e) => setEditingData(prev => ({ ...prev, thinkingMode: e.target.checked }))}
                            className="w-4 h-4 text-amber-600 border-stone-300 rounded focus:ring-amber-500"
                          />
                          <span className="text-sm text-stone-700">思考模式</span>
                        </label>
                      </div>

                      <div className="flex justify-end gap-3 pt-4 border-t border-stone-200">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelEdit();
                          }}
                          disabled={saving}
                          className="px-4 py-2 text-stone-600 border border-stone-300 rounded-lg hover:bg-stone-50 transition-colors"
                        >
                          取消
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleUpdateModel();
                          }}
                          disabled={saving || !editingData.name || !editingData.baseUrl || !editingData.model}
                          className="flex items-center gap-2 px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {saving && <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />}
                          <SaveIcon size="sm" />
                          保存更改
                        </button>
                      </div>
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
