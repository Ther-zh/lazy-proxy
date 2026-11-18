import { appendFileSync, mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string) => void;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024;

export function shouldLog(min: LogLevel, level: LogLevel): boolean {
  return RANK[level] >= RANK[min];
}

/** 追加式文件日志（每次写完即关闭；超过上限轮转为 .1；任何失败都静默降级） */
export function createFileLogger(
  filePath: string,
  minLevel: LogLevel = "info",
  maxBytes: number = DEFAULT_MAX_LOG_BYTES,
): Logger {
  let broken = false;
  const rotateIfNeeded = (): void => {
    try {
      if (statSync(filePath).size > maxBytes) {
        const backup = `${filePath}.1`;
        try {
          rmSync(backup, { force: true });
        } catch {
          /* 备份清理失败时继续尝试 rename */
        }
        renameSync(filePath, backup);
      }
    } catch {
      /* 文件尚不存在 */
    }
  };
  return (level, message) => {
    if (broken || !shouldLog(minLevel, level)) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      rotateIfNeeded();
      appendFileSync(filePath, `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`, "utf8");
    } catch {
      broken = true;
    }
  };
}

/** 控制台日志（脚本/无文件场景） */
export function makeConsoleLogger(minLevel: LogLevel = "info"): Logger {
  return (level, message) => {
    if (!shouldLog(minLevel, level)) return;
    console.log(`[lazy-proxy] ${level}: ${message}`);
  };
}

/** 为 mihomo 子进程打开 core.log（stdout/stderr 共用），失败返回 null（调用方回退 ignore） */
export function openCoreLog(dataDir: string, maxBytes: number = DEFAULT_MAX_LOG_BYTES): number | null {
  const filePath = join(dataDir, "core.log");
  try {
    mkdirSync(dataDir, { recursive: true });
    try {
      if (statSync(filePath).size > maxBytes) {
        const backup = `${filePath}.1`;
        try {
          rmSync(backup, { force: true });
        } catch {
          /* ignore */
        }
        renameSync(filePath, backup);
      }
    } catch {
      /* 文件尚不存在 */
    }
    return openSync(filePath, "a");
  } catch {
    return null;
  }
}
