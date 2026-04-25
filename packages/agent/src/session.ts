import type { ConversationMessage } from "@nichijou/shared";
import { AgentLoop } from "./loop.js";
import type { AgentEvent, AgentSessionOptions, SessionState } from "./events.js";

function toConversationHistoryMessage(message: ConversationMessage): ConversationMessage {
  const historyMessage: ConversationMessage = { ...message };
  delete historyMessage.reasoningContent;
  return historyMessage;
}

export class AgentSession {
  private loop: AgentLoop;
  private _state: SessionState;
  private subscribers: Array<(event: AgentEvent) => void> = [];

  constructor(opts: AgentSessionOptions) {
    const initialMessages = opts.messages ?? [
      { role: "system" as const, content: opts.systemPrompt },
    ];

    this._state = {
      messages: initialMessages.map(toConversationHistoryMessage),
      systemPrompt: opts.systemPrompt,
      tools: opts.tools ?? [],
    };

    this.loop = new AgentLoop({
      provider: opts.provider,
      tools: opts.tools ?? [],
      maxTurns: opts.maxTurns,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });

    if (opts.onEvent) {
      this.subscribers.push(opts.onEvent);
    }
  }

  get state(): SessionState {
    return this._state;
  }

  subscribe(handler: (event: AgentEvent) => void): () => void {
    this.subscribers.push(handler);
    return () => {
      const idx = this.subscribers.indexOf(handler);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  private emit(event: AgentEvent): void {
    for (const handler of this.subscribers) {
      handler(event);
    }
  }

  async prompt(input: string | ConversationMessage): Promise<string> {
    const userMessage: ConversationMessage = typeof input === "string"
      ? { role: "user", content: input }
      : input;
    this._state.messages.push(toConversationHistoryMessage(userMessage));

    let fullResponse = "";

    for await (const event of this.loop.run(this._state.messages)) {
      this.emit(event);
      if (event.type === "text_delta") {
        fullResponse += event.delta;
      }
    }

    return fullResponse;
  }

  updateSystemPrompt(prompt: string): void {
    this._state.systemPrompt = prompt;
    if (this._state.messages.length > 0 && this._state.messages[0]!.role === "system") {
      this._state.messages[0] = { role: "system", content: prompt };
    }
  }

  replaceMessages(messages: ConversationMessage[], systemPrompt?: string): void {
    const nextMessages = messages.map(toConversationHistoryMessage);
    const prompt = systemPrompt ?? this._state.systemPrompt;

    if (nextMessages.length === 0 || nextMessages[0]!.role !== "system") {
      nextMessages.unshift({ role: "system", content: prompt });
    }

    this._state.messages = nextMessages;
    const firstContent = nextMessages[0]!.content;
    this._state.systemPrompt = systemPrompt ?? (typeof firstContent === "string" ? firstContent : prompt);
  }

  updateTools(tools: AgentSessionOptions["tools"] = []): void {
    const nextTools = tools ?? [];
    this._state.tools = nextTools;
    this.loop.updateTools(nextTools);
  }

  getMessages(): ConversationMessage[] {
    return this._state.messages.map(toConversationHistoryMessage);
  }

  clearHistory(): void {
    this._state.messages = [
      { role: "system", content: this._state.systemPrompt },
    ];
  }
}

export function createAgentSession(opts: AgentSessionOptions): AgentSession {
  return new AgentSession(opts);
}
