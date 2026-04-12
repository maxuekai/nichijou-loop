import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";

const SOUL_TEMPLATES = [
  {
    name: "温暖贴心",
    content: `# 管家人格

你是"小日子"，一个温暖细心的家庭管家。

## 语气
- 亲切但不啰嗦，像一个贴心的家人
- 提醒时温和但坚定

## 偏好
- 优先考虑家庭成员的健康
- 推荐活动时注重性价比
- 做饭建议偏向营养均衡`,
  },
  {
    name: "简洁高效",
    content: `# 管家人格

你是"管家"，一个高效专业的家庭助理。

## 语气
- 简洁直接，不废话
- 用数据和事实说话

## 偏好
- 效率优先
- 给出明确的建议和方案
- 时间管理严格`,
  },
  {
    name: "幽默风趣",
    content: `# 管家人格

你是"日常君"，一个风趣幽默的家庭管家。

## 语气
- 轻松幽默，偶尔开个小玩笑
- 提醒时用有趣的方式表达

## 偏好
- 让家庭生活充满乐趣
- 推荐新奇有趣的活动
- 做饭建议偏向创意料理`,
  },
];

const LLM_PRESETS = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", needsKey: true },
  { name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-20250514", needsKey: true },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", needsKey: true },
  { name: "豆包", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-pro-32k", needsKey: true },
  { name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5", needsKey: false },
  { name: "LM Studio (本地)", baseUrl: "http://localhost:1234/v1", model: "default", needsKey: false },
];

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  const [llmConfig, setLlmConfig] = useState({ baseUrl: "", apiKey: "", model: "" });
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmResult, setLlmResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const [familyName, setFamilyName] = useState("我的家");
  const [homeCity, setHomeCity] = useState("");
  const [homeAdcode, setHomeAdcode] = useState("");
  const [adminName, setAdminName] = useState("");

  const [soulContent, setSoulContent] = useState(SOUL_TEMPLATES[0]!.content);

  const steps = ["配置 LLM", "创建家庭", "管家人格", "完成"];

  async function testLLM() {
    setLlmTesting(true);
    setLlmResult(null);
    try {
      const result = await api.testLLM(llmConfig);
      setLlmResult(result);
    } catch (err) {
      setLlmResult({ ok: false, error: err instanceof Error ? err.message : "连接失败" });
    }
    setLlmTesting(false);
  }

  async function finishSetup() {
    await api.updateConfig({ llm: llmConfig });
    await api.createFamily({
      name: familyName,
      homeCity: homeCity.trim() || undefined,
      homeAdcode: homeAdcode.trim() || undefined,
    });
    if (adminName) {
      await api.addMember(adminName, "admin");
    }
    await api.updateSoul(soulContent);
    await api.completeSetup();
    onComplete();
    navigate("/admin");
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-stone-50 to-orange-50">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold text-stone-800 mb-2">Nichijou Loop</h1>
          <p className="text-stone-500">家庭 AI 管家 · 初始设置</p>
        </div>

        {/* Progress */}
        <div className="flex items-center justify-center gap-2 mb-12">
          {steps.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                i <= step ? "bg-amber-500 text-white" : "bg-stone-200 text-stone-400"
              }`}>
                {i + 1}
              </div>
              <span className={`text-sm hidden sm:inline ${i <= step ? "text-stone-700" : "text-stone-400"}`}>{s}</span>
              {i < steps.length - 1 && <div className={`w-8 h-px ${i < step ? "bg-amber-500" : "bg-stone-200"}`} />}
            </div>
          ))}
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-8">
          {step === 0 && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold text-stone-800">配置 AI 模型</h2>
              <p className="text-stone-500 text-sm">选择预设或自定义配置。本地模型（Ollama）不需要 API Key。</p>

              <div className="flex flex-wrap gap-2">
                {LLM_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    onClick={() => setLlmConfig({ baseUrl: preset.baseUrl, apiKey: llmConfig.apiKey, model: preset.model })}
                    className={`px-4 py-2 rounded-lg text-sm border transition-colors ${
                      llmConfig.baseUrl === preset.baseUrl
                        ? "border-amber-500 bg-amber-50 text-amber-700"
                        : "border-stone-200 text-stone-600 hover:border-stone-300"
                    }`}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Base URL</label>
                  <input
                    type="text"
                    value={llmConfig.baseUrl}
                    onChange={(e) => setLlmConfig({ ...llmConfig, baseUrl: e.target.value })}
                    className="w-full px-4 py-2.5 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">API Key</label>
                  <input
                    type="password"
                    value={llmConfig.apiKey}
                    onChange={(e) => setLlmConfig({ ...llmConfig, apiKey: e.target.value })}
                    className="w-full px-4 py-2.5 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                    placeholder="sk-... (本地模型可留空)"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">模型</label>
                  <input
                    type="text"
                    value={llmConfig.model}
                    onChange={(e) => setLlmConfig({ ...llmConfig, model: e.target.value })}
                    className="w-full px-4 py-2.5 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                    placeholder="gpt-4o"
                  />
                </div>
              </div>

              <div className="flex items-center gap-4">
                <button
                  onClick={testLLM}
                  disabled={!llmConfig.baseUrl || !llmConfig.model || llmTesting}
                  className="px-4 py-2 rounded-lg bg-stone-100 text-stone-700 text-sm font-medium hover:bg-stone-200 disabled:opacity-50 transition-colors"
                >
                  {llmTesting ? "测试中..." : "测试连接"}
                </button>
                {llmResult && (
                  <span className={`text-sm ${llmResult.ok ? "text-green-600" : "text-red-500"}`}>
                    {llmResult.ok ? "连接成功" : llmResult.error}
                  </span>
                )}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold text-stone-800">创建家庭</h2>
              <p className="text-stone-500 text-sm">给你的家庭取个名字，并创建管理员账号。</p>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">家庭名称</label>
                <input
                  type="text"
                  value={familyName}
                  onChange={(e) => setFamilyName(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  placeholder="我的家"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">你的名字</label>
                <input
                  type="text"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  placeholder="爸爸 / 妈妈 / ..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">家庭常居城市（用于天气等工具）</label>
                <input
                  type="text"
                  value={homeCity}
                  onChange={(e) => setHomeCity(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  placeholder="例如：深圳"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">常居地行政区编码（可选）</label>
                <input
                  type="text"
                  value={homeAdcode}
                  onChange={(e) => setHomeAdcode(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  placeholder="例如：440300"
                />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold text-stone-800">选择管家人格</h2>
              <p className="text-stone-500 text-sm">选一个模板，或者自定义管家的性格。后续可在设置中修改。</p>
              <div className="flex gap-2">
                {SOUL_TEMPLATES.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => setSoulContent(t.content)}
                    className={`px-4 py-2 rounded-lg text-sm border transition-colors ${
                      soulContent === t.content
                        ? "border-amber-500 bg-amber-50 text-amber-700"
                        : "border-stone-200 text-stone-600 hover:border-stone-300"
                    }`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
              <textarea
                value={soulContent}
                onChange={(e) => setSoulContent(e.target.value)}
                rows={12}
                className="w-full px-4 py-3 rounded-lg border border-stone-300 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 resize-none"
              />
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6 text-center py-8">
              <div className="text-5xl">🎉</div>
              <h2 className="text-xl font-semibold text-stone-800">设置完成！</h2>
              <p className="text-stone-500">你的家庭管家已经准备就绪。</p>
              <div className="bg-stone-50 rounded-lg p-4 text-left text-sm text-stone-600 space-y-1">
                <p>AI 模型：{llmConfig.model} @ {llmConfig.baseUrl}</p>
                <p>家庭：{familyName}</p>
                <p>常居地：{homeAdcode || homeCity || "未设置"}</p>
                <p>管理员：{adminName || "默认用户"}</p>
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="flex justify-between mt-8 pt-6 border-t border-stone-100">
            <button
              onClick={() => setStep(step - 1)}
              disabled={step === 0}
              className="px-6 py-2.5 rounded-lg text-sm text-stone-600 hover:bg-stone-50 disabled:invisible transition-colors"
            >
              上一步
            </button>
            {step < 3 ? (
              <button
                onClick={() => setStep(step + 1)}
                className="px-6 py-2.5 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
              >
                下一步
              </button>
            ) : (
              <button
                onClick={finishSetup}
                className="px-6 py-2.5 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
              >
                开始使用
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
