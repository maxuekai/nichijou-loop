import type { Message, ToolCall, ToolDefinition, MultimodalMessage, MediaContent } from "@nichijou/shared";
import { LLMError } from "@nichijou/shared";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ProviderConfig,
  StreamEvent,
  Usage,
} from "./types.js";

interface OpenAIContentPart {
  type: 'text' | 'image_url' | 'audio';
  text?: string;
  image_url?: { url: string; detail?: 'low' | 'high' | 'auto' };
  audio?: { format: string; data: string };
}

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  reasoning_content?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const DEFAULT_TIME_ZONE = "Asia/Shanghai";

/** Convert image file to base64 data URL */
async function imageToBase64DataUrl(filePath: string, mimeType?: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const type = mimeType || 'image/jpeg';
  const base64 = buffer.toString('base64');
  return `data:${type};base64,${base64}`;
}

/** Convert audio file to base64 */
async function audioToBase64(filePath: string, format?: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return buffer.toString('base64');
}

/** Convert MediaContent to OpenAI content parts */
async function mediaContentToParts(mediaList: MediaContent[]): Promise<OpenAIContentPart[]> {
  const parts: OpenAIContentPart[] = [];
  
  for (const media of mediaList) {
    try {
      switch (media.type) {
        case 'image':
          const imageUrl = await imageToBase64DataUrl(media.filePath, media.mimeType);
          parts.push({
            type: 'image_url',
            image_url: { 
              url: imageUrl,
              detail: 'high' // 默认使用高质量
            }
          });
          break;
        
        case 'voice':
          const audioFormat = media.mimeType?.split('/')[1] || 'mp3';
          const audioData = await audioToBase64(media.filePath, audioFormat);
          parts.push({
            type: 'audio',
            audio: {
              format: audioFormat,
              data: audioData
            }
          });
          break;
        
        // 文件和视频暂时不直接支持，可以转为文本描述
        case 'file':
        case 'video':
          parts.push({
            type: 'text',
            text: `[${media.type.toUpperCase()}文件: ${media.originalName || '未知文件'}${media.size ? `, 大小: ${(media.size / 1024 / 1024).toFixed(2)}MB` : ''}]`
          });
          break;
      }
    } catch (error) {
      console.error(`处理媒体文件失败 ${media.filePath}:`, error);
      parts.push({
        type: 'text',
        text: `[媒体文件处理失败: ${media.originalName || '未知文件'}]`
      });
    }
  }
  
  return parts;
}

async function toOpenAIMessages(messages: (Message | MultimodalMessage)[], includeReasoningContent = false): Promise<OpenAIMessage[]> {
  const result: OpenAIMessage[] = [];
  
  for (const m of messages) {
    const msg: OpenAIMessage = { role: m.role, content: null };
    
    // 处理基本字段
    if (m.name) msg.name = m.name;
    if (m.toolCallId) msg.tool_call_id = m.toolCallId;
    if (m.toolCalls && m.toolCalls.length > 0) {
      msg.tool_calls = m.toolCalls;
    }
    if (includeReasoningContent && m.role === "assistant" && m.reasoningContent) {
      msg.reasoning_content = m.reasoningContent;
    }
    
    // 处理内容
    const isMultimodal = 'media' in m && m.media && m.media.length > 0;
    
    if (isMultimodal) {
      // 多模态消息，构建 content parts
      const parts: OpenAIContentPart[] = [];
      
      // 添加文本内容
      if (typeof m.content === 'string' && m.content.trim()) {
        parts.push({ type: 'text', text: m.content });
      }
      
      // 添加媒体内容
      if (m.media && m.media.length > 0) {
        const mediaParts = await mediaContentToParts(m.media);
        parts.push(...mediaParts);
      }
      
      msg.content = parts.length > 0 ? parts : m.content;
    } else {
      // 纯文本消息
      msg.content = m.content;
    }
    
    result.push(msg);
  }
  
  return result;
}

function isDeepSeekProvider(config: ProviderConfig): boolean {
  const provider = config.provider?.toLowerCase() ?? "";
  const baseUrl = config.baseUrl.toLowerCase();
  return provider === "deepseek" || baseUrl.includes("deepseek.com");
}

function normalizeTimeZone(timeZone?: string): string {
  if (!timeZone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function getTimeZoneOffset(date: Date, timeZone: string): string {
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const local = new Date(date.toLocaleString("en-US", { timeZone }));
  const diffMinutes = (local.getTime() - utc.getTime()) / 60000;
  const sign = diffMinutes >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(diffMinutes) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(diffMinutes) % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function buildCurrentTimeMessage(timeZone: string): OpenAIMessage {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const display = `${get("year")}年${get("month")}月${get("day")}日 ${get("weekday")} ${hour}:${get("minute")}:${get("second")}`;
  const localIso = now.toLocaleString("sv-SE", { timeZone }).replace(" ", "T");
  const offset = getTimeZoneOffset(now, timeZone);

  return {
    role: "system",
    content: [
      "# 当前时间",
      "",
      `现在是 ${display}`,
      `ISO: ${localIso}${offset} (${timeZone})`,
      `UTC: ${now.toISOString()}`,
      "请根据此精确时间推算用户描述中涉及的具体日期时间。当用户说「明天」「后天」「下周一」等相对时间时，必须以此时间为基准计算。",
    ].join("\n"),
  };
}

function toOpenAITools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function fromOpenAIMessage(choice: Record<string, unknown>): Message {
  const msg = choice.message as Record<string, unknown>;
  const result: Message = {
    role: msg.role as Message["role"],
    content: (msg.content as string) ?? "",
  };
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
    result.reasoningContent = msg.reasoning_content;
  }
  if (msg.tool_calls) {
    result.toolCalls = msg.tool_calls as ToolCall[];
  }
  return result;
}

function extractUsage(data: Record<string, unknown>): Usage {
  const u = (data.usage ?? {}) as Record<string, number>;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
  };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      timeZone: normalizeTimeZone(config.timeZone),
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = await this.buildRequestBody(request, false);
    const data = await this.fetchJSON("/chat/completions", body);

    const choices = data.choices as Record<string, unknown>[];
    if (!choices?.[0]) {
      throw new LLMError("No choices in response");
    }

    return {
      message: fromOpenAIMessage(choices[0]),
      usage: extractUsage(data),
      finishReason: (choices[0].finish_reason as string) ?? "stop",
    };
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const body = await this.buildRequestBody(request, true);
    const response = await this.fetchRaw("/chat/completions", body);

    if (!response.body) {
      throw new LLMError("No response body for streaming");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const accumulated: {
      content: string;
      reasoningContent: string;
      toolCalls: Map<number, { id: string; name: string; arguments: string }>;
    } = { content: "", reasoningContent: "", toolCalls: new Map() };
    let finishReason = "stop";
    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (parsed.usage) {
            usage = extractUsage(parsed);
          }

          const choices = parsed.choices as Record<string, unknown>[] | undefined;
          if (!choices?.[0]) continue;
          const delta = choices[0].delta as Record<string, unknown> | undefined;
          if (!delta) continue;

          if (choices[0].finish_reason) {
            finishReason = choices[0].finish_reason as string;
          }

          if (typeof delta.content === "string" && delta.content) {
            accumulated.content += delta.content;
            yield { type: "text_delta", delta: delta.content };
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            accumulated.reasoningContent += delta.reasoning_content;
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls as Record<string, unknown>[]) {
              const idx = tc.index as number;
              const fn = tc.function as Record<string, string> | undefined;
              if (!accumulated.toolCalls.has(idx)) {
                accumulated.toolCalls.set(idx, {
                  id: (tc.id as string) ?? "",
                  name: fn?.name ?? "",
                  arguments: "",
                });
              }
              const entry = accumulated.toolCalls.get(idx)!;
              if (tc.id) entry.id = tc.id as string;
              if (fn?.name) entry.name = fn.name;
              if (fn?.arguments) {
                entry.arguments += fn.arguments;
                yield {
                  type: "tool_call_delta",
                  toolCallId: entry.id,
                  name: entry.name,
                  argumentsDelta: fn.arguments,
                };
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const message: Message = {
      role: "assistant",
      content: accumulated.content,
    };
    if (accumulated.reasoningContent) {
      message.reasoningContent = accumulated.reasoningContent;
    }
    if (accumulated.toolCalls.size > 0) {
      message.toolCalls = [...accumulated.toolCalls.values()].map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }

    yield { type: "done", message, usage, finishReason };
  }

  private async buildRequestBody(
    request: ChatRequest,
    stream: boolean,
  ): Promise<Record<string, unknown>> {
    const deepSeek = isDeepSeekProvider(this.config);
    const thinkingEnabled = this.config.thinkingMode === true;
    const messages = await toOpenAIMessages(request.messages, thinkingEnabled);
    const body: Record<string, unknown> = {
      model: request.model ?? this.config.model,
      messages: [buildCurrentTimeMessage(this.config.timeZone ?? DEFAULT_TIME_ZONE), ...messages],
      stream,
    };
    if (deepSeek) {
      body.thinking = { type: thinkingEnabled ? "enabled" : "disabled" };
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.tools && request.tools.length > 0) {
      body.tools = toOpenAITools(request.tools);
    }
    if (stream) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  private async fetchJSON(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchRaw(path, body);
    const data = (await response.json()) as Record<string, unknown>;
    if (data.error) {
      const err = data.error as Record<string, string>;
      throw new LLMError(err.message ?? "Unknown LLM error");
    }
    return data;
  }

  private async fetchRaw(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 120_000),
    });

    if (!response.ok) {
      let errMsg = `LLM API error: ${response.status} ${response.statusText}`;
      try {
        const errBody = (await response.json()) as Record<string, unknown>;
        if (errBody.error) {
          const e = errBody.error as Record<string, string>;
          errMsg = e.message ?? errMsg;
        }
      } catch {
        // ignore parse error
      }
      throw new LLMError(errMsg);
    }

    return response;
  }
}
