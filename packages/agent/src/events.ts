import type { LLMProvider, Usage } from "@nichijou/ai";
import type { ConversationMessage, Message, ToolDefinition } from "@nichijou/shared";

export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; params: unknown }
  | { type: "tool_end"; toolName: string; result: string; isError: boolean }
  | { type: "turn_end"; message: Message; usage: Usage }
  | { type: "agent_end" }
  | { type: "error"; error: Error };

export interface AgentSessionOptions {
  provider: LLMProvider;
  systemPrompt: string;
  tools?: ToolDefinition[];
  messages?: ConversationMessage[];
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  onEvent?: (event: AgentEvent) => void;
}

export interface SessionState {
  messages: ConversationMessage[];
  systemPrompt: string;
  tools: ToolDefinition[];
}
