import type { ToolDefinition } from "@nichijou/shared";

export interface PluginContext {
  dataDir: string;
  readData(key: string): Promise<string | null>;
  writeData(key: string, value: string): Promise<void>;
  log(message: string): void;
}

export interface ScheduledTask {
  id: string;
  cron: string;
  description: string;
  execute: (ctx: PluginContext) => Promise<void>;
}

export interface DashboardWidget {
  id: string;
  name: string;
  component: string;
  defaultSize: "small" | "medium" | "large";
}

export interface PluginConfigField {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface NichijouPlugin {
  id: string;
  name: string;
  description: string;
  version: string;

  tools: ToolDefinition[];
  configSchema?: Record<string, PluginConfigField>;

  onInstall?(ctx: PluginContext): Promise<void>;
  onUninstall?(ctx: PluginContext): Promise<void>;

  scheduledTasks?: ScheduledTask[];
  dashboardWidgets?: DashboardWidget[];
}
