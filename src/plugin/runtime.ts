import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/manager";
import { CoreManager, defaultCoreDeps } from "../core/manager";
import { startShimServer } from "../shim/server";

/**
 * 运行时装配模块：供插件入口（src/plugin/index.ts）与单元测试使用。
 *
 * 注意：opencode 会把插件文件「导出的每一个函数」都当作插件加载，
 * 因此本模块的辅助函数不能从插件入口 re-export（否则加载器会当成插件调用而崩溃）。
 */
export function resolveConfigDir(): string {
  const override = process.env.LAZYPROXY_CONFIG_DIR;
  if (override && override.trim()) return override.trim();
  return join(homedir(), ".config", "lazyproxy");
}

export interface LazyProxyHandle {
  port: number;
  close: () => void;
}

/** 装配核心管理器 + shim 服务器；未配置订阅时返回 null（不抛错，避免拖垮 opencode） */
export function startLazyProxy(cfgDir: string): LazyProxyHandle | null {
  const cfg = loadConfig(cfgDir);
  if (!cfg.subscriptionUrl) return null;
  const dataDir = join(cfgDir, "data");
  mkdirSync(dataDir, { recursive: true });
  const core = new CoreManager(cfg, dataDir, defaultCoreDeps());
  return startShimServer(cfg, core);
}
