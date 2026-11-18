import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/manager";
import type { LazyProxyConfig } from "../config/schema";
import { createFileLogger } from "../core/log";
import { CoreManager, defaultCoreDeps } from "../core/manager";
import { effectiveProxyHosts, startShimServer, type ShimHandle } from "../shim/server";
import { installFetchPatch, type FetchPatchHandle } from "./fetch-patch";

/**
 * 运行时装配模块：供插件入口（src/plugin/index.ts）与单元测试使用。
 *
 * 注意：本模块的辅助函数不在插件入口 re-export（入口只暴露 V2 默认定义与 V1 兼容入口）。
 */
export function resolveConfigDir(): string {
  const override = process.env.LAZYPROXY_CONFIG_DIR;
  if (override && override.trim()) return override.trim();
  return join(homedir(), ".config", "lazyproxy");
}

interface ActiveRuntime {
  cfgDir: string;
  handle: ShimHandle;
  refs: number;
}

let active: ActiveRuntime | null = null;

/** 安装进程内 fetch 补丁：带上重试配置与落盘日志（供插件入口与测试复用） */
export function installRuntimeFetchPatch(
  cfgDir: string,
  port: number,
  cfg: LazyProxyConfig,
): FetchPatchHandle {
  const logger = createFileLogger(join(cfgDir, "data", "lazyproxy.log"), cfg.logLevel);
  return installFetchPatch({
    shimPort: port,
    hosts: effectiveProxyHosts(cfg),
    retry: {
      forever: cfg.retryForever ?? true,
      delayMs: cfg.retryDelayMs,
      maxDelayMs: cfg.retryMaxDelayMs,
    },
    log: (message) => logger("warn", message),
  });
}

/**
 * 装配核心管理器 + shim 服务器；未配置订阅时返回 null（不抛错，避免拖垮 opencode）。
 *
 * V2 会按 location 多次调用 setup；这里按调用方引用计数，任一 location dispose
 * 只释放自己的引用，最后一个引用释放时才真正关闭 shim。
 */
export async function startLazyProxy(cfgDir: string): Promise<ShimHandle | null> {
  if (active && active.cfgDir === cfgDir) {
    active.refs += 1;
    return consumerHandle(active);
  }
  const cfg = loadConfig(cfgDir);
  if (!cfg.subscriptionUrl) return null;
  const dataDir = join(cfgDir, "data");
  mkdirSync(dataDir, { recursive: true });
  const logger = createFileLogger(join(dataDir, "lazyproxy.log"), cfg.logLevel);
  const core = new CoreManager(cfg, dataDir, { ...defaultCoreDeps(), log: logger });
  const handle = await startShimServer(cfg, core, { log: (m) => logger("info", m) });
  logger("info", `shim listening on 127.0.0.1:${handle.port}`);
  const runtime: ActiveRuntime = { cfgDir, handle, refs: 1 };
  active = runtime;
  return consumerHandle(runtime);
}

function consumerHandle(runtime: ActiveRuntime): ShimHandle {
  let released = false;
  return {
    port: runtime.handle.port,
    close: () => {
      if (released) return;
      released = true;
      runtime.refs -= 1;
      if (runtime.refs > 0) return;
      if (active === runtime) active = null;
      runtime.handle.close();
    },
  };
}
