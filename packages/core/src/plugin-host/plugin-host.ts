import type { ToolDefinition, ToolResult } from "@nichijou/shared";
import type { StorageManager } from "../storage/storage.js";

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  tools: ToolDefinition[];
}

export class PluginHost {
  private plugins = new Map<string, PluginManifest>();
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  register(plugin: PluginManifest): void {
    this.plugins.set(plugin.id, plugin);
    console.log(`[Plugin] 已注册: ${plugin.name} v${plugin.version} (${plugin.tools.length} tools)`);
  }

  clear(): void {
    this.plugins.clear();
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
      if (tool) return tool.execute(params);
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
    const configContent = this.storage.readText(`plugins/${pluginId}/config.yaml`);
    if (!configContent) return true;
    return !configContent.includes("enabled: false");
  }
}
