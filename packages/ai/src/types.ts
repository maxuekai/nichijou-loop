import type { Message, ToolDefinition } from "@nichijou/shared";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeout?: number;
  thinkingMode?: boolean;
}

export interface ChatRequest {
  model?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  message: Message;
  usage: Usage;
  finishReason: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_delta"; toolCallId: string; name: string; argumentsDelta: string }
  | { type: "done"; message: Message; usage: Usage; finishReason: string }
  | { type: "error"; error: Error };

export interface LLMProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<StreamEvent>;
  readonly config: ProviderConfig;
}
