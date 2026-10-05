import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/manager";
import { CoreManager, defaultCoreDeps } from "../core/manager";
import { startShimServer } from "../shim/server";

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

interface PluginCtx {
  client?: {
    app?: {
      log?: (args: {
        body: { service: string; level: string; message: string; extra?: Record<string, unknown> };
      }) => Promise<unknown>;
    };
  };
}

/** opencode 插件入口：启动懒代理；任何失败只记日志，绝不影响 opencode 本体 */
export const LazyProxyPlugin = async (ctx: PluginCtx): Promise<Record<string, unknown>> => {
  const log = (level: string, message: string) => {
    const fn = ctx?.client?.app?.log;
    if (fn) void fn({ body: { service: "lazy-proxy", level, message } });
    else console.log(`[lazy-proxy] ${level}: ${message}`);
  };
  try {
    const cfgDir = resolveConfigDir();
    const handle = startLazyProxy(cfgDir);
    if (!handle) {
      log("warn", `no subscription configured yet; edit ${join(cfgDir, "config.json")}`);
      return {};
    }
    log(
      "info",
      `shim on 127.0.0.1:${handle.port}; set provider.openai.options.baseURL to http://127.0.0.1:${handle.port}`,
    );
  } catch (e) {
    log("error", `failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {};
};
