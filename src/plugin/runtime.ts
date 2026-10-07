import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/manager";
import { CoreManager, defaultCoreDeps } from "../core/manager";
import { startShimServer, type ShimHandle } from "../shim/server";

/**
 * 运行时装配模块：供插件入口（src/plugin/index.ts）与单元测试使用。
 *
 * 注意：本模块的辅助函数不在插件入口 re-export（入口保持只导出 LazyProxyPlugin 一个插件函数）。
 */
export function resolveConfigDir(): string {
  const override = process.env.LAZYPROXY_CONFIG_DIR;
  if (override && override.trim()) return override.trim();
  return join(homedir(), ".config", "lazyproxy");
}

let active: { cfgDir: string; handle: ShimHandle } | null = null;

/** 装配核心管理器 + shim 服务器；未配置订阅时返回 null（不抛错，避免拖垮 opencode）。 */
export async function startLazyProxy(cfgDir: string): Promise<ShimHandle | null> {
  if (active && active.cfgDir === cfgDir) return active.handle;
  const cfg = loadConfig(cfgDir);
  if (!cfg.subscriptionUrl) return null;
  const dataDir = join(cfgDir, "data");
  mkdirSync(dataDir, { recursive: true });
  const core = new CoreManager(cfg, dataDir, defaultCoreDeps());
  const handle = await startShimServer(cfg, core);
  let closed = false;
  const wrapped: ShimHandle = {
    port: handle.port,
    close: () => {
      if (closed) return;
      closed = true;
      if (active && active.handle === wrapped) active = null;
      handle.close();
    },
  };
  active = { cfgDir, handle: wrapped };
  return wrapped;
}
