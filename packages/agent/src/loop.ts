import type { LLMProvider, StreamEvent, Usage } from "@nichijou/ai";
import type { Message, ToolDefinition } from "@nichijou/shared";
import type { AgentEvent } from "./events.js";
import { ToolRunner } from "./tool-runner.js";

const DEFAULT_MAX_TURNS = 10;

export class AgentLoop {
  private provider: LLMProvider;
  private toolRunner: ToolRunner;
  private tools: ToolDefinition[];
  private maxTurns: number;
  private temperature?: number;
  private maxTokens?: number;

  constructor(opts: {
    provider: LLMProvider;
    tools: ToolDefinition[];
    maxTurns?: number;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.provider = opts.provider;
    this.tools = opts.tools;
    this.toolRunner = new ToolRunner(opts.tools);
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.temperature = opts.temperature;
    this.maxTokens = opts.maxTokens;
  }

  async *run(messages: Message[]): AsyncIterable<AgentEvent> {
    let turns = 0;

    while (turns < this.maxTurns) {
      turns++;
      let assistantMessage: Message | undefined;
      let turnUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      const stream = this.provider.chatStream({
        messages,
        tools: this.tools.length > 0 ? this.tools : undefined,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
      });

      for await (const event of stream) {
        if (event.type === "text_delta") {
          yield { type: "text_delta", delta: event.delta };
        } else if (event.type === "done") {
          assistantMessage = event.message;
          turnUsage = event.usage;
        } else if (event.type === "error") {
          yield { type: "error", error: event.error };
          return;
        }
      }

      if (!assistantMessage) {
        yield { type: "error", error: new Error("No response from LLM") };
        return;
      }

      messages.push(assistantMessage);
      yield { type: "turn_end", message: assistantMessage, usage: turnUsage };

      if (!assistantMessage.toolCalls || assistantMessage.toolCalls.length === 0) {
        break;
      }

      for (const toolCall of assistantMessage.toolCalls) {
        yield { type: "tool_start", toolName: toolCall.function.name, params: toolCall.function.arguments };

        const result = await this.toolRunner.execute(toolCall);

        yield {
          type: "tool_end",
          toolName: toolCall.function.name,
          result: result.content,
          isError: result.isError ?? false,
        };

        messages.push({
          role: "tool",
          content: result.content,
          toolCallId: toolCall.id,
        });
      }
    }

    yield { type: "agent_end" };
  }
}
