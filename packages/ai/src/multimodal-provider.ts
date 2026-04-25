import type { 
  ConversationMessage,
  MultimodalMessage, 
  MediaContent, 
  MultimediaConfig 
} from "@nichijou/shared";
import type { 
  ChatRequest, 
  ChatResponse, 
  LLMProvider, 
  StreamEvent 
} from "./types.js";

export interface MultimodalProviderConfig {
  providers: {
    openai?: LLMProvider;
    claude?: LLMProvider;
  };
  multimedia: MultimediaConfig;
  transcriptionService?: TranscriptionService;
}

export interface TranscriptionService {
  transcribe(audioPath: string, language?: string): Promise<string>;
}

/** 检测消息是否包含多媒体内容 */
function hasMultimedia(message: ConversationMessage): boolean {
  return 'media' in message && Boolean(message.media) && message.media!.length > 0;
}

/** 检测消息中的媒体类型 */
function getMediaTypes(message: MultimodalMessage): Set<string> {
  const types = new Set<string>();
  if (message.media) {
    message.media.forEach(media => types.add(media.type));
  }
  return types;
}

/** 多模态提供商选择器 */
export class MultimodalProviderSelector {
  private config: MultimodalProviderConfig;

  constructor(config: MultimodalProviderConfig) {
    this.config = config;
  }

  /** 根据消息内容选择最佳的 LLM 提供商 */
  selectProvider(messages: ConversationMessage[]): LLMProvider {
    // 检查是否有多媒体内容
    const multimediaMessages = messages.filter(hasMultimedia) as MultimodalMessage[];
    
    if (multimediaMessages.length === 0) {
      // 纯文本消息，使用默认提供商
      return this.getDefaultProvider();
    }

    // 分析媒体类型
    const allMediaTypes = new Set<string>();
    multimediaMessages.forEach(msg => {
      getMediaTypes(msg).forEach(type => allMediaTypes.add(type));
    });

    // 根据媒体类型选择提供商
    if (allMediaTypes.has('image') && allMediaTypes.has('voice')) {
      // 混合媒体
      return this.getProviderByStrategy(this.config.multimedia.providers.mixed);
    } else if (allMediaTypes.has('voice')) {
      // 仅语音
      return this.getProviderByStrategy(this.config.multimedia.providers.voice);
    } else if (allMediaTypes.has('image')) {
      // 仅图片
      return this.getProviderByStrategy(this.config.multimedia.providers.image);
    }

    return this.getDefaultProvider();
  }

  /** 根据配置策略获取提供商 */
  private getProviderByStrategy(strategy: string): LLMProvider {
    switch (strategy) {
      case 'openai':
        if (this.config.providers.openai) {
          return this.config.providers.openai;
        }
        break;
      case 'claude':
        if (this.config.providers.claude) {
          return this.config.providers.claude;
        }
        break;
      case 'auto':
        // 自动选择：优先 OpenAI（支持更多模态）
        return this.config.providers.openai || this.config.providers.claude || this.getDefaultProvider();
    }
    
    return this.getDefaultProvider();
  }

  private getDefaultProvider(): LLMProvider {
    return this.config.providers.openai || this.config.providers.claude!;
  }

  /** 预处理消息，处理语音转录等 */
  async preprocessMessages(messages: ConversationMessage[]): Promise<ConversationMessage[]> {
    const processed: ConversationMessage[] = [];

    for (const msg of messages) {
      if (!hasMultimedia(msg)) {
        const standardMsg: ConversationMessage = {
          role: msg.role,
          content: msg.content,
          name: msg.name,
          toolCallId: msg.toolCallId,
          toolCalls: msg.toolCalls,
        };
        processed.push(standardMsg);
        continue;
      }

      const multimodalMsg = msg as MultimodalMessage;
      let processedMsg = { ...multimodalMsg };

      // 处理语音转录
      if (this.config.multimedia.voice_processing.strategy === 'transcribe_only' && 
          multimodalMsg.media?.some(m => m.type === 'voice')) {
        
        processedMsg = await this.transcribeVoiceMessage(processedMsg);
      }

      const standardMsg: ConversationMessage = {
        role: processedMsg.role,
        content: processedMsg.content,
        name: processedMsg.name,
        toolCallId: processedMsg.toolCallId,
        toolCalls: processedMsg.toolCalls,
        reasoningContent: processedMsg.reasoningContent,
        media: processedMsg.media,
        references: processedMsg.references,
      };

      processed.push(standardMsg);
    }

    return processed;
  }

  /** 转录语音消息为文本 */
  private async transcribeVoiceMessage(msg: MultimodalMessage): Promise<MultimodalMessage> {
    if (!this.config.transcriptionService || !msg.media) {
      return msg;
    }

    const transcriptions: string[] = [];
    const nonVoiceMedia: MediaContent[] = [];

    for (const media of msg.media) {
      if (media.type === 'voice') {
        try {
          const transcription = await this.config.transcriptionService.transcribe(
            media.filePath,
            this.config.multimedia.voice_processing.transcription_language
          );
          transcriptions.push(`[语音转录]: ${transcription}`);
        } catch (error) {
          console.error('语音转录失败:', error);
          transcriptions.push(`[语音文件: ${media.originalName || '未知文件'}，转录失败]`);
        }
      } else {
        nonVoiceMedia.push(media);
      }
    }

    // 将转录结果添加到文本内容中
    const originalContent = typeof msg.content === 'string' ? msg.content : '';
    const transcribedContent = transcriptions.join('\n');
    const newContent = [originalContent, transcribedContent].filter(Boolean).join('\n');

    return {
      ...msg,
      content: newContent,
      media: nonVoiceMedia.length > 0 ? nonVoiceMedia : undefined
    };
  }

  /** 包装提供商以支持多模态处理 */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const preprocessedMessages = await this.preprocessMessages(request.messages);
    const provider = this.selectProvider(preprocessedMessages);
    
    return provider.chat({
      ...request,
      messages: preprocessedMessages
    });
  }

  /** 包装流式聊天以支持多模态处理 */
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const preprocessedMessages = await this.preprocessMessages(request.messages);
    const provider = this.selectProvider(preprocessedMessages);
    
    yield* provider.chatStream({
      ...request,
      messages: preprocessedMessages
    });
  }
}
