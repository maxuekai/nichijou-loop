import yaml from "js-yaml";
import type { StorageManager } from "./storage.js";
import type { MultimediaConfig } from "@nichijou/shared";

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  thinkingMode?: boolean;
}

export interface LLMModelConfig {
  id: string;              // 模型唯一标识
  name: string;            // 显示名称
  provider: string;        // 厂商标识（openai/kimi/minimax等）
  baseUrl: string;         // API端点
  apiKey: string;          // API密钥
  model: string;           // 模型名称
  timeout?: number;        // 超时设置
  thinkingMode?: boolean;  // 是否启用思考模式，需要回传 reasoning_content
  enabled: boolean;        // 是否启用
  isDefault: boolean;      // 是否为默认模型
  createdAt: string;       // 创建时间
  lastUsedAt?: string;     // 最后使用时间
}

export interface ModelsConfig {
  models: LLMModelConfig[];
  activeModelId: string;   // 当前活跃模型ID
}

export interface WeChatConfig {
  typingIndicator?: {
    enabled: boolean;
    timeoutSeconds: number;
  };
}

export interface NichijouConfig {
  // 保留原有 llm 字段用于向后兼容
  llm: LLMConfig;
  // 新增多模型配置
  models?: ModelsConfig;
  // 多媒体处理配置
  multimedia?: MultimediaConfig;
  port: number;
  timezone: string;
  setupCompleted: boolean;
  butlerName?: string;
  plugins?: string[];
  wechat?: WeChatConfig;
}

const DEFAULT_CONFIG: NichijouConfig = {
  llm: {
    baseUrl: "http://localhost:11434/v1",
    apiKey: "",
    model: "qwen2.5",
  },
  multimedia: {
    providers: {
      image: 'auto',
      voice: 'auto',
      mixed: 'auto',
    },
    voice_processing: {
      strategy: 'both_options',
      transcription_language: 'zh',
    },
    storage: {
      base_path: '~/.nichijou/media',
      cleanup_days: 30,
      max_file_size_mb: 50,
    },
    references: {
      max_thread_depth: 10,
      include_media_in_context: true,
    },
  },
  port: 3000,
  timezone: "Asia/Shanghai",
  setupCompleted: false,
  butlerName: "Nichijou",
  wechat: {
    typingIndicator: {
      enabled: true,
      timeoutSeconds: 30,
    },
  },
};

export class ConfigManager {
  private config: NichijouConfig;
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
    this.config = this.load();
  }

  private load(): NichijouConfig {
    const content = this.storage.readText("config.yaml");
    if (!content) {
      this.save(DEFAULT_CONFIG);
      return { ...DEFAULT_CONFIG };
    }
    const parsed = yaml.load(content) as Partial<NichijouConfig>;
    const config = { ...DEFAULT_CONFIG, ...parsed };
    
    // 执行配置迁移
    this.migrate(config);
    
    return config;
  }

  /**
   * 配置迁移逻辑
   */
  private migrate(config: NichijouConfig): void {
    let needSave = false;

    // 如果存在旧的 llm 配置但没有新的 models 配置，进行迁移
    if (config.llm && !config.models) {
      const legacyModel: LLMModelConfig = {
        id: 'legacy-default',
        name: '默认模型',
        provider: 'legacy',
        baseUrl: config.llm.baseUrl,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        thinkingMode: config.llm.thinkingMode ?? false,
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString()
      };

      config.models = {
        models: [legacyModel],
        activeModelId: legacyModel.id
      };

      needSave = true;
    }

    if (needSave) {
      this.save(config);
    }
  }

  get(): NichijouConfig {
    return { ...this.config };
  }

  update(patch: Partial<NichijouConfig>): void {
    const newConfig = { ...this.config, ...patch };
    this.validateConfig(newConfig);
    this.config = newConfig;
    this.save(this.config);
  }

  private save(config: NichijouConfig): void {
    this.storage.writeText("config.yaml", yaml.dump(config, { lineWidth: 120 }));
  }

  /**
   * 验证配置的有效性
   */
  private validateConfig(config: NichijouConfig): void {
    // 验证端口号
    if (config.port < 1 || config.port > 65535) {
      throw new Error(`无效的端口号: ${config.port}，必须在 1-65535 范围内`);
    }

    // 验证多媒体配置
    if (config.multimedia) {
      this.validateMultimediaConfig(config.multimedia);
    }

    // 验证模型配置
    if (config.models) {
      this.validateModelsConfig(config.models);
    }
  }

  /**
   * 验证多媒体配置
   */
  private validateMultimediaConfig(config: MultimediaConfig): void {
    // 验证提供商选择
    const validProviders = ['claude', 'openai', 'auto'];
    if (!validProviders.includes(config.providers.image)) {
      throw new Error(`无效的图片处理提供商: ${config.providers.image}`);
    }
    if (!validProviders.includes(config.providers.voice)) {
      throw new Error(`无效的语音处理提供商: ${config.providers.voice}`);
    }
    if (!validProviders.includes(config.providers.mixed)) {
      throw new Error(`无效的混合媒体处理提供商: ${config.providers.mixed}`);
    }

    // 验证语音处理策略
    const validVoiceStrategies = ['multimodal_native', 'transcribe_only', 'both_options'];
    if (!validVoiceStrategies.includes(config.voice_processing.strategy)) {
      throw new Error(`无效的语音处理策略: ${config.voice_processing.strategy}`);
    }

    // 验证存储配置
    if (config.storage.cleanup_days < 1) {
      throw new Error(`清理天数必须大于 0: ${config.storage.cleanup_days}`);
    }
    if (config.storage.max_file_size_mb < 1 || config.storage.max_file_size_mb > 500) {
      throw new Error(`最大文件大小必须在 1-500MB 范围内: ${config.storage.max_file_size_mb}`);
    }

    // 验证引用配置
    if (config.references.max_thread_depth < 1 || config.references.max_thread_depth > 50) {
      throw new Error(`最大线程深度必须在 1-50 范围内: ${config.references.max_thread_depth}`);
    }
  }

  /**
   * 验证模型配置
   */
  private validateModelsConfig(config: ModelsConfig): void {
    if (!config.models || config.models.length === 0) {
      throw new Error('至少需要配置一个模型');
    }

    // 验证活跃模型ID是否存在
    const activeModel = config.models.find(m => m.id === config.activeModelId);
    if (!activeModel) {
      throw new Error(`找不到活跃模型: ${config.activeModelId}`);
    }

    // 验证模型配置
    for (const model of config.models) {
      if (!model.id || !model.name || !model.baseUrl) {
        throw new Error(`模型配置不完整: ${model.id || '未知模型'}`);
      }
      
      // 验证 URL 格式
      try {
        new URL(model.baseUrl);
      } catch {
        throw new Error(`无效的 baseUrl: ${model.baseUrl}`);
      }
    }
  }

  /**
   * 获取多媒体配置，如果不存在则返回默认配置
   */
  getMultimediaConfig(): MultimediaConfig {
    return this.config.multimedia || DEFAULT_CONFIG.multimedia!;
  }

  /**
   * 更新多媒体配置
   */
  updateMultimediaConfig(config: Partial<MultimediaConfig>): void {
    const currentMultimedia = this.getMultimediaConfig();
    const newMultimedia = { ...currentMultimedia, ...config };
    this.validateMultimediaConfig(newMultimedia);
    
    this.update({
      multimedia: newMultimedia
    });
  }

  /**
   * 重置多媒体配置为默认值
   */
  resetMultimediaConfig(): void {
    this.update({
      multimedia: DEFAULT_CONFIG.multimedia!
    });
  }
}
