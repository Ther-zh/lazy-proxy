import { join } from "node:path";
import { loadConfig } from "../config/manager";
import type { LazyProxyConfig } from "../config/schema";
import { effectiveProxyHosts, type ShimHandle } from "../shim/server";
import { injectProxyEnv, type ProxyEnvHandle } from "./env";
import { installFetchPatch, type FetchPatchHandle } from "./fetch-patch";
import { resolveConfigDir, startLazyProxy } from "./runtime";

interface AppLogger {
  log?: (args: {
    body: { service: string; level: string; message: string; extra?: Record<string, unknown> };
  }) => unknown;
}

interface PluginCtx {
  client?: { app?: AppLogger };
}

/**
 * opencode 插件入口：进程内 fetch 拦截 + 代理 env 注入 + 懒代理；任何失败只记日志，绝不影响 opencode 本体。
 *
 * 历史坑（导致 "failed to load plugin"）：早期把 SDK 方法解构后裸调用
 * （`const fn = ctx.client.app.log; fn(...)`），`this` 丢失 → 抛
 * "Cannot read properties of undefined (reading '_client')" → 整个插件文件加载失败。
 * 所以：① 日志必须以方法形式调用（`app.log(...)`，保留 receiver）；
 *       ② 日志调用全部兜底，绝不外抛。
 * 另：本文件保持只导出 LazyProxyPlugin 一个插件函数。
 */
export const LazyProxyPlugin = async (ctx: PluginCtx): Promise<Record<string, unknown>> => {
  const log = makeSafeLog(ctx);
  try {
    const cfgDir = resolveConfigDir();
    let handle: ShimHandle | null;
    try {
      handle = await startLazyProxy(cfgDir);
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "EADDRINUSE") {
        const cfg = loadConfig(cfgDir);
        const envHandle = injectProxyEnv(cfg.shimPort);
        const fetchHandle = safeInstallFetchPatch(cfg.shimPort, cfg);
        log(
          "info",
          `shim port ${cfg.shimPort} already in use; assuming an existing shim; proxy env + fetch interception enabled`,
        );
        return {
          dispose: async () => {
            try {
              fetchHandle?.restore();
            } catch {
              /* noop */
            }
            envHandle.restore();
          },
        };
      }
      throw e;
    }
    if (!handle) {
      log("warn", `no subscription configured yet; edit ${join(cfgDir, "config.json")}`);
      return {};
    }
    const cfg = loadConfig(cfgDir);
    const envHandle: ProxyEnvHandle = injectProxyEnv(handle.port);
    const fetchHandle = safeInstallFetchPatch(handle.port, cfg);
    log(
      "info",
      `shim on 127.0.0.1:${handle.port}; OpenAI traffic goes through the lazy core (in-process fetch interception), all other hosts pass through directly`,
    );
    return {
      dispose: async () => {
        try {
          fetchHandle?.restore();
        } catch {
          /* noop */
        }
        try {
          handle.close();
        } catch {
          /* noop */
        }
        try {
          envHandle.restore();
        } catch {
          /* noop */
        }
      },
    };
  } catch (e) {
    log("error", `failed to start: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
};

/** 安装 fetch 补丁；任何失败都不拖垮插件加载 */
function safeInstallFetchPatch(port: number, cfg: LazyProxyConfig): FetchPatchHandle | null {
  try {
    return installFetchPatch({ shimPort: port, hosts: effectiveProxyHosts(cfg) });
  } catch {
    return null;
  }
}

/** 日志兜底：绑定 receiver 调用 SDK 方法；任何异常/拒绝都不外抛 */
function makeSafeLog(ctx: PluginCtx): (level: string, message: string) => void {
  return (level, message) => {
    try {
      const app = ctx?.client?.app;
      if (app && typeof app.log === "function") {
        const result = app.log({ body: { service: "lazy-proxy", level, message } });
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          (result as Promise<unknown>).catch(() => {
            /* ignore log failure */
          });
        }
        return;
      }
    } catch {
      /* fall through to console */
    }
    console.log(`[lazy-proxy] ${level}: ${message}`);
  };
}
