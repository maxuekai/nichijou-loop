import yaml from "js-yaml";
import type { StorageManager } from "./storage.js";

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface WeChatConfig {
  typingIndicator?: {
    enabled: boolean;
    timeoutSeconds: number;
  };
}

export interface NichijouConfig {
  llm: LLMConfig;
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
    return { ...DEFAULT_CONFIG, ...parsed };
  }

  get(): NichijouConfig {
    return { ...this.config };
  }

  update(patch: Partial<NichijouConfig>): void {
    this.config = { ...this.config, ...patch };
    this.save(this.config);
  }

  private save(config: NichijouConfig): void {
    this.storage.writeText("config.yaml", yaml.dump(config, { lineWidth: 120 }));
  }
}
