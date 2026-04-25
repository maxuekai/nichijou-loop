import type { WeixinMessage } from "wechat-ilink-client";
import { WeChatClient } from "wechat-ilink-client";
import type { 
  MediaContent, 
  ReferenceContent, 
  InboundMessage,
  MediaProcessingResult
} from "@nichijou/shared";
import { generateId } from "@nichijou/shared";
import type { StorageManager, Database } from "@nichijou/core";
import { ErrorHandler, DownloadTaskManager, type DownloadTask, type DownloadProgress } from "@nichijou/core";

export interface ParsedMultimediaMessage {
  text: string;
  mediaContent: MediaContent[];
  references: ReferenceContent[];
  messageId: string;
  hasContent: boolean;
}

export interface MultimediaParserConfig {
  storage: StorageManager;
  database: Database;
  connectionId: string;
  memberId: string;
  maxFileSize: number; // MB
  onDownloadProgress?: (progress: DownloadProgress) => void;
  onDownloadComplete?: (task: DownloadTask, result: MediaContent) => void;
  onDownloadError?: (task: DownloadTask, error: Error) => void;
}

export class MultimediaMessageParser {
  private config: MultimediaParserConfig;
  private client: WeChatClient;
  private errorHandler: ErrorHandler;
  private downloadTaskManager: DownloadTaskManager;
  private readonly downloadTimeoutMs = 60_000;

  constructor(config: MultimediaParserConfig, client: WeChatClient) {
    this.config = config;
    this.client = client;
    this.errorHandler = new ErrorHandler({
      enableTextFallback: true,
      enableMediaSkip: true,
      enableReferenceFallback: true,
      maxRetries: 3,
      retryDelayMs: 1000,
    });

    // 初始化下载任务管理器
    this.downloadTaskManager = new DownloadTaskManager();
    
    // 监听下载任务事件
    this.downloadTaskManager.on('taskProgress', (progress: DownloadProgress) => {
      this.config.onDownloadProgress?.(progress);
    });
    
    this.downloadTaskManager.on('taskCompleted', (task: DownloadTask, result: MediaContent) => {
      this.config.onDownloadComplete?.(task, result);
    });
    
    this.downloadTaskManager.on('taskError', (task: DownloadTask, error: Error) => {
      this.config.onDownloadError?.(task, error);
    });
  }

  /**
   * 解析微信多媒体消息
   */
  async parseMessage(msg: WeixinMessage): Promise<ParsedMultimediaMessage> {
    const messageId = generateId("msg");
    let text = "";
    const mediaContent: MediaContent[] = [];
    const references: ReferenceContent[] = [];

    // 解析消息内容
    if (msg.item_list && msg.item_list.length > 0) {
      for (const item of msg.item_list) {
        try {
          // 处理文本内容
          if (item.text_item?.text) {
            text += item.text_item.text;
          }

          // 处理媒体内容
          if (item.image_item || item.voice_item || item.file_item || item.video_item) {
            try {
              const media = await this.processMediaItem(item, messageId);
              if (media.success && media.content) {
                mediaContent.push(media.content);
              } else if (media.error) {
                // 使用错误处理器处理媒体错误
                const mediaInfo = this.extractMediaInfo(item);
                const errorResult = await this.errorHandler.handleMediaDownloadError(
                  new Error(media.error),
                  mediaInfo,
                  { memberId: this.config.memberId, messageId }
                );
                
                if (errorResult.shouldSkip && errorResult.fallbackText) {
                  text += `\n${errorResult.fallbackText}`;
                }
              }
            } catch (error) {
              // 处理意外错误
              const mediaInfo = this.extractMediaInfo(item);
              const errorResult = await this.errorHandler.handleMediaDownloadError(
                error instanceof Error ? error : new Error('未知媒体处理错误'),
                mediaInfo,
                { memberId: this.config.memberId, messageId }
              );
              
              if (errorResult.shouldSkip && errorResult.fallbackText) {
                text += `\n${errorResult.fallbackText}`;
              }
            }
          }

          // 处理引用消息
          if (item.ref_msg) {
            const reference = await this.processReferenceMessage(item.ref_msg, messageId);
            if (reference) {
              references.push(reference);
            }
          }

        } catch (error) {
          console.error('[MultimediaParser] 处理消息项失败:', error);
          text += `\n[消息解析失败: ${error instanceof Error ? error.message : '未知错误'}]`;
        }
      }
    } else {
      // 兼容旧版本，使用 extractText
      text = WeChatClient.extractText(msg) || "";
    }

    // 保存消息引用关系到数据库
    for (const ref of references) {
      this.config.database.saveMessageReference({
        id: generateId("ref"),
        messageId,
        referencedMessageId: ref.messageId,
        referenceType: 'reply',
      });
    }

    return {
      text: text.trim(),
      mediaContent,
      references,
      messageId,
      hasContent: text.trim().length > 0 || mediaContent.length > 0,
    };
  }

  private maxFileSizeBytes(): number {
    return this.config.maxFileSize * 1024 * 1024;
  }

  private formatBytes(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  }

  private extractNumericSize(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  private extractDeclaredMediaSizeBytes(item: any): number | null {
    const containers = [
      item,
      item?.image_item,
      item?.voice_item,
      item?.video_item,
      item?.file_item,
    ];
    const keys = ["size", "file_size", "fileSize", "total_size", "totalSize", "data_size", "dataSize"];

    for (const container of containers) {
      if (!container || typeof container !== "object") continue;
      for (const key of keys) {
        const size = this.extractNumericSize(container[key]);
        if (size !== null) return size;
      }
    }

    return null;
  }

  /**
   * 处理媒体项
   */
  private async processMediaItem(item: any, messageId: string): Promise<MediaProcessingResult> {
    const mediaInfo = this.extractMediaInfo(item);
    const declaredSize = this.extractDeclaredMediaSizeBytes(item);
    
    // 创建下载任务
    const downloadTask = this.downloadTaskManager.createTask(
      messageId,
      this.config.memberId,
      mediaInfo.type,
      mediaInfo.originalName || '未知文件',
      declaredSize ?? 0
    );

    try {
      if (declaredSize !== null && declaredSize > this.maxFileSizeBytes()) {
        const error = new Error(`文件大小 ${this.formatBytes(declaredSize)} 超过限制 ${this.config.maxFileSize}MB`);
        this.downloadTaskManager.errorTask(downloadTask.id, error);
        return {
          success: false,
          error: error.message,
        };
      }

      // 开始下载任务
      this.downloadTaskManager.startTask(downloadTask.id);

      // 下载媒体文件（使用带进度的版本）
      const downloadResult = await this.downloadMediaWithProgress(item, downloadTask);
      
      if (!downloadResult) {
        this.downloadTaskManager.errorTask(downloadTask.id, new Error('下载媒体文件失败'));
        return { success: false, error: '下载媒体文件失败' };
      }

      // 检查文件大小
      if (!downloadResult.data || !Buffer.isBuffer(downloadResult.data)) {
        const error = new Error('下载媒体文件数据无效');
        this.downloadTaskManager.errorTask(downloadTask.id, error);
        return { success: false, error: error.message };
      }

      const sizeMB = downloadResult.data.length / (1024 * 1024);
      if (sizeMB > this.config.maxFileSize) {
        const error = new Error(`文件大小 ${sizeMB.toFixed(2)}MB 超过限制 ${this.config.maxFileSize}MB`);
        this.downloadTaskManager.errorTask(downloadTask.id, error);
        return { 
          success: false, 
          error: error.message
        };
      }

      // 获取文件信息
      const originalName = downloadResult.fileName || `media_${Date.now()}`;
      const mimeType = this.inferMimeType(downloadResult.kind, originalName);

      // 保存到存储管理器
      const mediaManager = this.config.storage.getMediaManager(this.config.database);
      const savedMedia = await mediaManager.saveMediaFile(
        downloadResult.data,
        originalName,
        messageId,
        Date.now()
      );

      // 标记任务完成
      this.downloadTaskManager.completeTask(downloadTask.id, savedMedia);

      return {
        success: true,
        content: savedMedia,
      };

    } catch (error) {
      console.error('[MultimediaParser] 处理媒体项失败:', error);
      const errorObj = error instanceof Error ? error : new Error('媒体处理失败');
      this.downloadTaskManager.errorTask(downloadTask.id, errorObj);
      
      return {
        success: false,
        error: errorObj.message,
      };
    }
  }

  /**
   * 带进度追踪的媒体下载
   */
  private async downloadMediaWithProgress(item: any, task: DownloadTask): Promise<any> {
    // 检查任务是否被取消
    if (task.abortController.signal.aborted) {
      throw new Error('下载任务已被取消');
    }

    // 模拟进度更新（实际实现需要根据 wechat-ilink-client 的 API）
    // 由于 wechat-ilink-client 可能不直接支持进度回调，我们需要包装这个过程
    const downloadPromise = this.client.downloadMedia(item);
    downloadPromise.catch(() => undefined);
    let timeout: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`下载媒体文件超时（${Math.round(this.downloadTimeoutMs / 1000)}秒）`));
      }, this.downloadTimeoutMs);
      abortHandler = () => reject(new Error('下载任务已被取消'));
      task.abortController.signal.addEventListener('abort', abortHandler, { once: true });
    });
    
    // 启动一个模拟的进度更新
    let progressInterval: NodeJS.Timeout;
    let isCompleted = false;
    
    // 模拟进度（因为无法获得真实进度）
    const simulateProgress = () => {
      if (isCompleted || task.abortController.signal.aborted) {
        return;
      }
      
      // 根据时间模拟进度增长
      const elapsed = Date.now() - task.startTime;
      const estimatedProgress = Math.min(90, (elapsed / 5000) * 100); // 假设5秒内达到90%
      
      this.downloadTaskManager.updateProgress(task.id, Math.round(estimatedProgress * task.totalSize / 100), task.totalSize);
    };

    progressInterval = setInterval(simulateProgress, 500);

    try {
      const result = await Promise.race([downloadPromise, timeoutPromise]);
      isCompleted = true;
      clearInterval(progressInterval);
      if (timeout) clearTimeout(timeout);
      if (abortHandler) task.abortController.signal.removeEventListener('abort', abortHandler);

      // 最终更新进度为100%
      if (result && result.data) {
        const totalSize = result.data.length;
        this.downloadTaskManager.updateProgress(task.id, totalSize, totalSize);
      }

      return result;
    } catch (error) {
      isCompleted = true;
      clearInterval(progressInterval);
      if (timeout) clearTimeout(timeout);
      if (abortHandler) task.abortController.signal.removeEventListener('abort', abortHandler);
      throw error;
    }
  }

  /**
   * 推断 MIME 类型
   */
  private inferMimeType(kind: string, fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase();
    
    switch (kind) {
      case 'image':
        if (ext === 'png') return 'image/png';
        if (ext === 'gif') return 'image/gif';
        if (ext === 'webp') return 'image/webp';
        return 'image/jpeg';
      
      case 'voice':
        if (ext === 'wav') return 'audio/wav';
        if (ext === 'm4a') return 'audio/mp4';
        if (ext === 'ogg') return 'audio/ogg';
        return 'audio/mpeg';
      
      case 'video':
        if (ext === 'webm') return 'video/webm';
        if (ext === 'mov') return 'video/quicktime';
        if (ext === 'avi') return 'video/x-msvideo';
        return 'video/mp4';
      
      case 'file':
        if (ext === 'pdf') return 'application/pdf';
        if (ext === 'doc') return 'application/msword';
        if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        if (ext === 'txt') return 'text/plain';
        if (ext === 'json') return 'application/json';
        return 'application/octet-stream';
      
      default:
        return 'application/octet-stream';
    }
  }

  /**
   * 处理引用消息
   */
  private async processReferenceMessage(refMsg: any, currentMessageId: string): Promise<ReferenceContent | null> {
    try {
      // 从引用消息中提取信息
      let refContent = "";
      const refMediaContent: MediaContent[] = [];

      if (refMsg.message_item) {
        // 提取引用消息的文本
        if (refMsg.message_item.text_item?.text) {
          refContent = refMsg.message_item.text_item.text;
        }

        // 处理引用消息中的媒体（如果有的话）
        if (refMsg.message_item.image_item || 
            refMsg.message_item.voice_item || 
            refMsg.message_item.file_item || 
            refMsg.message_item.video_item) {
          
          const mediaResult = await this.processMediaItem(refMsg.message_item, `${currentMessageId}_ref`);
          if (mediaResult.success && mediaResult.content) {
            refMediaContent.push(mediaResult.content);
          }
        }
      }

      // 生成引用消息ID（在实际应用中，应该从消息中提取真实的ID）
      const referenceId = generateId("ref_msg");

      return {
        messageId: referenceId,
        content: refContent,
        mediaContent: refMediaContent.length > 0 ? refMediaContent : undefined,
        timestamp: Date.now(),
        authorId: this.config.memberId,
        authorName: undefined, // 可以从用户信息中获取
      };

    } catch (error) {
      console.error('[MultimediaParser] 处理引用消息失败:', error);
      return null;
    }
  }

  /**
   * 构建完整的 InboundMessage
   */
  buildInboundMessage(
    parsedMsg: ParsedMultimediaMessage, 
    originalMsg: WeixinMessage
  ): InboundMessage {
    return {
      channel: "wechat",
      memberId: this.config.memberId,
      text: parsedMsg.text,
      mediaContent: parsedMsg.mediaContent.length > 0 ? parsedMsg.mediaContent : undefined,
      references: parsedMsg.references.length > 0 ? parsedMsg.references : undefined,
      contextToken: originalMsg.context_token,
      timestamp: originalMsg.create_time_ms,
      messageId: parsedMsg.messageId,
    };
  }

  /**
   * 从消息项中提取媒体信息
   */
  private extractMediaInfo(item: any): { type: string; originalName?: string } {
    if (item.image_item) {
      return { type: 'image', originalName: '图片文件' };
    } else if (item.voice_item) {
      return { type: 'voice', originalName: '语音文件' };
    } else if (item.video_item) {
      return { type: 'video', originalName: '视频文件' };
    } else if (item.file_item) {
      return { 
        type: 'file', 
        originalName: item.file_item.file_name || '未知文件' 
      };
    }
    
    return { type: 'unknown', originalName: '未知媒体' };
  }

  /**
   * 获取错误处理统计信息
   */
  getErrorStats() {
    return this.errorHandler.getErrorStats();
  }

  /**
   * 清理过期的错误记录
   */
  cleanupErrorRecords(): void {
    this.errorHandler.cleanupOldErrors();
  }

  /**
   * 获取下载任务管理器（用于外部访问）
   */
  getDownloadTaskManager(): DownloadTaskManager {
    return this.downloadTaskManager;
  }

  /**
   * 获取成员的所有下载任务
   */
  getMemberDownloadTasks(): DownloadTask[] {
    return this.downloadTaskManager.getMemberTasks(this.config.memberId);
  }

  /**
   * 取消指定的下载任务
   */
  cancelDownloadTask(taskId: string, reason: string = '用户请求取消'): boolean {
    return this.downloadTaskManager.cancelTask(taskId, reason);
  }

  /**
   * 取消该成员的所有活跃下载任务
   */
  cancelAllDownloadTasks(): number {
    return this.downloadTaskManager.cancelMemberTasks(this.config.memberId);
  }

  /**
   * 获取下载统计信息
   */
  getDownloadStats() {
    return this.downloadTaskManager.getStats();
  }

  /**
   * 清理临时文件（如果处理失败）
   */
  async cleanup(messageId: string): Promise<void> {
    try {
      // 取消该消息相关的所有未完成下载任务
      const allTasks = this.downloadTaskManager.getAllTasks();
      const messageTasks = allTasks.filter(task => task.messageId === messageId);
      
      for (const task of messageTasks) {
        if (task.status === 'downloading' || task.status === 'pending') {
          this.downloadTaskManager.cancelTask(task.id, `消息 ${messageId} 被清理`);
        }
      }

      console.log(`[MultimediaParser] 清理消息相关文件和任务: ${messageId}`);
    } catch (error) {
      console.error('[MultimediaParser] 清理失败:', error);
    }
  }

  /**
   * 销毁解析器，清理所有资源
   */
  destroy(): void {
    try {
      // 取消所有活跃的下载任务
      this.cancelAllDownloadTasks();
      
      // 销毁下载任务管理器
      this.downloadTaskManager.destroy();
      
      console.log(`[MultimediaParser] 解析器已销毁 (${this.config.connectionId})`);
    } catch (error) {
      console.error('[MultimediaParser] 销毁失败:', error);
    }
  }
}
