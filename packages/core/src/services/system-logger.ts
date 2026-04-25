import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import type { SystemLogKind, SystemLogLevel } from "@nichijou/shared";
import type { Database } from "../db/database.js";

type ConsoleWriter = (...data: unknown[]) => void;

interface ConsoleWriters {
  log: ConsoleWriter;
  info: ConsoleWriter;
  warn: ConsoleWriter;
  error: ConsoleWriter;
}

export interface StructuredLogPayload {
  level?: SystemLogLevel;
  source: string;
  message: string;
  input?: unknown;
  output?: unknown;
  details?: unknown;
  error?: unknown;
  durationMs?: number;
  traceId?: string;
  maxJsonLength?: number | null;
  maxStringLength?: number | null;
  fullPayload?: boolean;
}

const SENSITIVE_KEY_PATTERN = /api[-_]?key|authorization|bearer|cookie|password|passwd|secret|session|token/i;
const MAX_JSON_LENGTH = 12000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_STRING_LENGTH = 4000;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 80;
const MAX_DEPTH = 8;

export class SystemLogger {
  private originals?: ConsoleWriters;
  private writing = false;

  constructor(private db: Database) {}

  installConsoleCapture(): void {
    if (this.originals) return;

    this.originals = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };

    console.log = (...args: unknown[]) => {
      this.originals?.log(...args);
      this.captureConsole("info", args);
    };
    console.info = (...args: unknown[]) => {
      this.originals?.info(...args);
      this.captureConsole("info", args);
    };
    console.warn = (...args: unknown[]) => {
      this.originals?.warn(...args);
      this.captureConsole("warn", args);
    };
    console.error = (...args: unknown[]) => {
      this.originals?.error(...args);
      this.captureConsole("error", args);
    };
  }

  restoreConsole(): void {
    if (!this.originals) return;
    console.log = this.originals.log as typeof console.log;
    console.info = this.originals.info as typeof console.info;
    console.warn = this.originals.warn as typeof console.warn;
    console.error = this.originals.error as typeof console.error;
    this.originals = undefined;
  }

  createTraceId(prefix = "trace"): string {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  logRuntime(payload: StructuredLogPayload): number | null {
    return this.write("runtime", {
      level: payload.level ?? "info",
      source: payload.source,
      message: payload.message,
      inputJson: this.safeJson(payload.input, payload.maxJsonLength, payload.maxStringLength, payload.fullPayload),
      outputJson: this.safeJson(payload.output, payload.maxJsonLength, payload.maxStringLength, payload.fullPayload),
      detailsJson: this.safeJson(payload.details, payload.maxJsonLength, payload.maxStringLength, payload.fullPayload),
      errorJson: this.safeJson(payload.error, payload.maxJsonLength, payload.maxStringLength, payload.fullPayload),
      durationMs: payload.durationMs,
      traceId: payload.traceId,
    });
  }

  logError(payload: StructuredLogPayload): number | null {
    return this.write("error", {
      level: "error",
      source: payload.source,
      message: payload.message,
      inputJson: this.safeJson(payload.input, payload.maxJsonLength, payload.maxStringLength, payload.fullPayload),
      outputJson: this.safeJson(payload.output, payload.maxJsonLength, payload.maxStringLength, payload.fullPayload),
      detailsJson: this.safeJson(payload.details, payload.maxJsonLength, payload.maxStringLength, payload.fullPayload),
      errorJson: this.safeJson(payload.error, payload.maxJsonLength, payload.maxStringLength, payload.fullPayload),
      durationMs: payload.durationMs,
      traceId: payload.traceId,
    });
  }

  private captureConsole(level: SystemLogLevel, args: unknown[]): void {
    if (this.writing) return;

    const { source, message } = this.parseConsoleMessage(args);
    const error = level === "error" ? args.find((arg) => arg instanceof Error) : undefined;
    const kind: SystemLogKind = level === "error" ? "error" : "runtime";

    this.write(kind, {
      level,
      source,
      message,
      detailsJson: this.safeJson({ args }),
      errorJson: error ? this.safeJson(error) : null,
    });
  }

  private write(kind: SystemLogKind, log: {
    level: SystemLogLevel;
    source: string;
    message: string;
    inputJson?: string | null;
    outputJson?: string | null;
    detailsJson?: string | null;
    errorJson?: string | null;
    durationMs?: number;
    traceId?: string;
  }): number | null {
    if (this.writing) return null;
    this.writing = true;
    try {
      return this.db.saveSystemLog({
        kind,
        level: log.level,
        source: this.truncate(log.source || "system", 200),
        message: this.truncate(log.message || "", MAX_MESSAGE_LENGTH),
        inputJson: log.inputJson,
        outputJson: log.outputJson,
        detailsJson: log.detailsJson,
        errorJson: log.errorJson,
        durationMs: log.durationMs,
        traceId: log.traceId,
      });
    } catch (error) {
      this.originals?.error("[SystemLogger] 写入系统日志失败:", error);
      return null;
    } finally {
      this.writing = false;
    }
  }

  private parseConsoleMessage(args: unknown[]): { source: string; message: string } {
    if (typeof args[0] === "string") {
      const match = args[0].match(/^\[([^\]]+)\]\s*(.*)$/);
      if (match) {
        const [, rawSource, rest] = match;
        const messageArgs = rest ? [rest, ...args.slice(1)] : args.slice(1);
        return {
          source: rawSource || "console",
          message: this.formatArgs(messageArgs.length > 0 ? messageArgs : args),
        };
      }
    }

    return {
      source: "console",
      message: this.formatArgs(args),
    };
  }

  private formatArgs(args: unknown[]): string {
    return args.map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      return inspect(this.redact(arg), { depth: 4, breakLength: 120, compact: true });
    }).join(" ");
  }

  private safeJson(
    value: unknown,
    maxJsonLength: number | null = MAX_JSON_LENGTH,
    maxStringLength: number | null = MAX_STRING_LENGTH,
    fullPayload = false,
  ): string | null {
    if (value === undefined) return null;
    try {
      const json = JSON.stringify(this.redact(value, 0, new WeakSet<object>(), maxStringLength, fullPayload), null, 2);
      return maxJsonLength === null ? json : this.truncate(json, maxJsonLength);
    } catch (error) {
      const json = JSON.stringify({
        serializationError: error instanceof Error ? error.message : String(error),
        preview: inspect(value, { depth: 2 }),
      });
      return maxJsonLength === null ? json : this.truncate(json, maxJsonLength);
    }
  }

  private redact(
    value: unknown,
    depth = 0,
    seen = new WeakSet<object>(),
    maxStringLength: number | null = MAX_STRING_LENGTH,
    fullPayload = false,
  ): unknown {
    if (value == null) return value;
    if (typeof value === "string") return maxStringLength === null ? value : this.truncate(value, maxStringLength);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "symbol") return value.toString();
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;

    if (value instanceof Error) {
      const errorLike = value as Error & { code?: unknown; status?: unknown; cause?: unknown };
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
        code: errorLike.code,
        status: errorLike.status,
        cause: errorLike.cause ? this.redact(errorLike.cause, depth + 1, seen, maxStringLength, fullPayload) : undefined,
      };
    }

    if (value instanceof Date) return value.toISOString();

    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    if (!fullPayload && depth >= MAX_DEPTH) return "[MaxDepth]";
    seen.add(value);

    if (Array.isArray(value)) {
      const limit = fullPayload ? value.length : MAX_ARRAY_LENGTH;
      const items = value.slice(0, limit).map((item) => this.redact(item, depth + 1, seen, maxStringLength, fullPayload));
      if (!fullPayload && value.length > MAX_ARRAY_LENGTH) items.push(`[${value.length - MAX_ARRAY_LENGTH} more items]`);
      return items;
    }

    const out: Record<string, unknown> = {};
    const allEntries = Object.entries(value as Record<string, unknown>);
    const entries = fullPayload ? allEntries : allEntries.slice(0, MAX_OBJECT_KEYS);
    for (const [key, child] of entries) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : this.redact(child, depth + 1, seen, maxStringLength, fullPayload);
    }

    const totalKeys = allEntries.length;
    if (!fullPayload && totalKeys > MAX_OBJECT_KEYS) {
      out.__truncatedKeys = totalKeys - MAX_OBJECT_KEYS;
    }

    return out;
  }

  private truncate(value: string, limit: number): string {
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}... [truncated ${value.length - limit} chars]`;
  }
}
