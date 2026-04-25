import { ConfigManager } from "../storage/config.js";
import type { LLMModelConfig, ModelsConfig } from "../storage/config.js";
import { createProvider } from "@nichijou/ai";
import type { LLMProvider } from "@nichijou/ai";
import type { AgentContext } from "../types/agent.js";

export class ModelManager {
  constructor(
    private config: ConfigManager,
    private decorateProvider: (provider: LLMProvider) => LLMProvider = (provider) => provider,
  ) {}

  private describeBaseUrl(baseUrl?: string): string {
    if (!baseUrl) return "";
    try {
      const parsed = new URL(baseUrl);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return baseUrl.replace(/([?&](?:api[-_]?key|token|secret)=)[^&]+/gi, "$1[REDACTED]");
    }
  }

  private describeModelConfig(model: Partial<LLMModelConfig>): Record<string, unknown> {
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      baseUrl: this.describeBaseUrl(model.baseUrl),
      model: model.model,
      enabled: model.enabled,
      isDefault: model.isDefault,
      hasApiKey: Boolean(model.apiKey),
    };
  }

  private describeLegacyConfig(llm: LLMModelConfig | { baseUrl?: string; apiKey?: string; model?: string; thinkingMode?: boolean }): Record<string, unknown> {
    return {
      baseUrl: this.describeBaseUrl(llm.baseUrl),
      model: llm.model,
      thinkingMode: llm.thinkingMode,
      hasApiKey: Boolean(llm.apiKey),
    };
  }

  /**
   * 获取所有模型配置
   */
  getAllModels(): LLMModelConfig[] {
    const cfg = this.config.get();
    console.log("[ModelManager] Config:", { hasModels: !!cfg.models, modelsCount: cfg.models?.models?.length || 0 });
    return cfg.models?.models || [];
  }

  /**
   * 获取当前活跃的模型
   */
  getActiveModel(): LLMModelConfig | null {
    const cfg = this.config.get();
    if (!cfg.models) return null;
    
    return cfg.models.models.find(m => m.id === cfg.models!.activeModelId) || null;
  }

  /**
   * 根据ID获取模型
   */
  getModelById(id: string): LLMModelConfig | null {
    const models = this.getAllModels();
    return models.find(m => m.id === id) || null;
  }

  /**
   * 添加新模型配置
   */
  addModel(modelConfig: Omit<LLMModelConfig, 'id' | 'createdAt'>): string {
    const cfg = this.config.get();
    const id = this.generateModelId();
    
    const newModel: LLMModelConfig = {
      ...modelConfig,
      id,
      createdAt: new Date().toISOString(),
    };

    // 初始化 models 配置如果不存在
    if (!cfg.models) {
      cfg.models = {
        models: [],
        activeModelId: id
      };
    }

    // 如果这是第一个模型或者新模型被标记为默认，设置为活跃模型
    if (cfg.models.models.length === 0 || newModel.isDefault) {
      // 将其他模型的 isDefault 设为 false
      cfg.models.models.forEach(m => m.isDefault = false);
      newModel.isDefault = true;
      newModel.lastUsedAt = new Date().toISOString(); // 设置使用时间
      cfg.models.activeModelId = id;
    }

    cfg.models.models.push(newModel);
    this.config.update({ models: cfg.models });

    return id;
  }

  /**
   * 更新模型配置
   */
  updateModel(id: string, updates: Partial<LLMModelConfig>): void {
    const cfg = this.config.get();
    if (!cfg.models) return;

    const modelIndex = cfg.models.models.findIndex(m => m.id === id);
    if (modelIndex === -1) {
      throw new Error(`Model with id ${id} not found`);
    }

    // 如果更新的模型被设置为默认，需要将其他模型的默认状态取消
    if (updates.isDefault === true) {
      cfg.models.models.forEach(m => {
        if (m.id !== id) {
          m.isDefault = false;
        }
      });
      cfg.models.activeModelId = id;
    }

    // 更新模型配置
    cfg.models.models[modelIndex] = {
      ...cfg.models.models[modelIndex],
      ...updates,
      id, // 确保 id 不被覆盖
    };

    this.config.update({ models: cfg.models });
  }

  /**
   * 删除模型配置
   */
  deleteModel(id: string): void {
    const cfg = this.config.get();
    if (!cfg.models) return;

    const modelIndex = cfg.models.models.findIndex(m => m.id === id);
    if (modelIndex === -1) {
      throw new Error(`Model with id ${id} not found`);
    }

    const isActiveModel = cfg.models.activeModelId === id;
    
    // 删除模型
    cfg.models.models.splice(modelIndex, 1);

    // 如果删除的是活跃模型，需要重新选择活跃模型
    if (isActiveModel && cfg.models.models.length > 0) {
      // 优先选择第一个启用的模型
      const enabledModel = cfg.models.models.find(m => m.enabled);
      if (enabledModel) {
        cfg.models.activeModelId = enabledModel.id;
        enabledModel.isDefault = true;
      } else {
        // 如果没有启用的模型，选择第一个模型
        cfg.models.activeModelId = cfg.models.models[0].id;
        cfg.models.models[0].isDefault = true;
      }
    } else if (cfg.models.models.length === 0) {
      // 如果没有模型了，重置 activeModelId
      cfg.models.activeModelId = '';
    }

    this.config.update({ models: cfg.models });
  }

  /**
   * 激活指定模型
   */
  activateModel(id: string): void {
    const cfg = this.config.get();
    if (!cfg.models) return;

    const model = cfg.models.models.find(m => m.id === id);
    if (!model) {
      throw new Error(`Model with id ${id} not found`);
    }

    if (!model.enabled) {
      throw new Error(`Cannot activate disabled model ${id}`);
    }

    // 取消其他模型的默认状态
    cfg.models.models.forEach(m => {
      m.isDefault = m.id === id;
    });

    cfg.models.activeModelId = id;
    
    // 更新最后使用时间
    model.lastUsedAt = new Date().toISOString();

    this.config.update({ models: cfg.models });
  }

  /**
   * 测试模型连接
   */
  async testModel(modelConfig: LLMModelConfig): Promise<{success: boolean, error?: string}> {
    try {
      const provider = this.decorateProvider(createProvider({
        provider: modelConfig.provider,
        baseUrl: modelConfig.baseUrl,
        apiKey: modelConfig.apiKey,
        model: modelConfig.model,
        timeout: modelConfig.timeout,
        thinkingMode: modelConfig.thinkingMode,
        timeZone: this.config.get().timezone,
      }));

      // 发送一个简单的测试消息
      const response = await provider.chat({
        messages: [{ role: "user", content: "Hello, this is a connection test. Please respond with 'OK'." }],
        temperature: 0.1,
        maxTokens: 10
      });

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 兼容性迁移：从旧配置格式迁移到新格式
   */
  migrateFromLegacyConfig(): void {
    const cfg = this.config.get();
    console.log("[ModelManager] Migration check - has llm:", !!cfg.llm, "has models:", !!cfg.models);
    
    // 如果存在旧的 llm 配置但没有新的 models 配置，进行迁移
    if (cfg.llm && !cfg.models) {
      console.log("[ModelManager] Migrating legacy config:", this.describeLegacyConfig(cfg.llm));
      const legacyModel: LLMModelConfig = {
        id: 'legacy-default',
        name: '默认模型',
        provider: 'legacy',
        baseUrl: cfg.llm.baseUrl,
        apiKey: cfg.llm.apiKey,
        model: cfg.llm.model,
        thinkingMode: cfg.llm.thinkingMode ?? false,
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString()
      };

      const modelsConfig: ModelsConfig = {
        models: [legacyModel],
        activeModelId: legacyModel.id
      };

      console.log("[ModelManager] Created models config:", {
        activeModelId: modelsConfig.activeModelId,
        models: modelsConfig.models.map((model) => this.describeModelConfig(model)),
      });
      this.config.update({ models: modelsConfig });
      console.log("[ModelManager] Migration completed");
    } else if (cfg.models) {
      console.log("[ModelManager] Models config already exists:", {
        activeModelId: cfg.models.activeModelId,
        models: cfg.models.models.map((model) => this.describeModelConfig(model)),
      });
    } else {
      console.log("[ModelManager] No llm config found, no migration needed");
    }
  }

  /**
   * 为未来agent模式预留：获取指定agent的模型
   */
  getModelForAgent(agentId: string): LLMModelConfig | null {
    // TODO: 实现agent模型绑定逻辑
    // 目前返回null，未来会从agent配置中查找绑定的modelId
    return null;
  }

  /**
   * 生成唯一的模型ID
   */
  private generateModelId(): string {
    return `model_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * 获取模型统计信息
   */
  getModelStats(): {
    total: number;
    enabled: number;
    disabled: number;
    byProvider: Record<string, number>;
  } {
    const models = this.getAllModels();
    const enabled = models.filter(m => m.enabled).length;
    
    const byProvider: Record<string, number> = {};
    models.forEach(m => {
      byProvider[m.provider] = (byProvider[m.provider] || 0) + 1;
    });

    return {
      total: models.length,
      enabled,
      disabled: models.length - enabled,
      byProvider
    };
  }
}
