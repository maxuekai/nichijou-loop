import yaml from "js-yaml";
import type { ToolDefinition, ToolResult } from "@nichijou/shared";
import type { StorageManager } from "../storage/storage.js";

export interface PluginConfigField {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  tools: ToolDefinition[];
  configSchema?: Record<string, PluginConfigField>;
}

export class PluginHost {
  private plugins = new Map<string, PluginManifest>();
  private pluginConfigs = new Map<string, Record<string, unknown>>();
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  register(plugin: PluginManifest): void {
    this.plugins.set(plugin.id, plugin);
    this.loadPluginConfig(plugin.id);
    console.log(`[Plugin] 已注册: ${plugin.name} v${plugin.version} (${plugin.tools.length} tools)`);
  }

  clear(): void {
    this.plugins.clear();
    this.pluginConfigs.clear();
  }

  getPlugin(id: string): PluginManifest | undefined {
    return this.plugins.get(id);
  }

  getAllPlugins(): PluginManifest[] {
    return [...this.plugins.values()];
  }

  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const plugin of this.plugins.values()) {
      tools.push(...plugin.tools);
    }
    return tools;
  }

  async executeTool(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
    for (const plugin of this.plugins.values()) {
      const tool = plugin.tools.find((t) => t.name === toolName);
      if (tool) {
        const config = this.pluginConfigs.get(plugin.id) ?? {};
        const merged = { ...config, ...params };
        return tool.execute(merged);
      }
    }
    return { content: `Tool not found: ${toolName}`, isError: true };
  }

  getAvailableTools(): Array<{ pluginId: string; pluginName: string; toolName: string; description: string }> {
    const result: Array<{ pluginId: string; pluginName: string; toolName: string; description: string }> = [];
    for (const plugin of this.plugins.values()) {
      for (const tool of plugin.tools) {
        result.push({ pluginId: plugin.id, pluginName: plugin.name, toolName: tool.name, description: tool.description });
      }
    }
    return result;
  }

  isEnabled(pluginId: string): boolean {
    const config = this.pluginConfigs.get(pluginId);
    if (!config) return true;
    return config.enabled !== false;
  }

  getPluginConfig(pluginId: string): Record<string, unknown> {
    return { ...(this.pluginConfigs.get(pluginId) ?? {}) };
  }

  setPluginConfig(pluginId: string, config: Record<string, unknown>): void {
    this.pluginConfigs.set(pluginId, { ...config });
    const filePath = `plugins/${pluginId}/config.yaml`;
    this.storage.writeText(filePath, yaml.dump(config, { lineWidth: 120 }));
  }

  private loadPluginConfig(pluginId: string): void {
    const content = this.storage.readText(`plugins/${pluginId}/config.yaml`);
    if (!content) {
      this.pluginConfigs.set(pluginId, {});
      return;
    }
    try {
      const parsed = yaml.load(content);
      this.pluginConfigs.set(pluginId, (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>);
    } catch {
      this.pluginConfigs.set(pluginId, {});
    }
  }
}
