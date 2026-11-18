import { join } from "node:path";
import { loadConfig } from "../config/manager";
import type { LazyProxyConfig } from "../config/schema";
import type { ShimHandle } from "../shim/server";
import { acquireProxyEnv } from "./env";
import type { FetchPatchHandle } from "./fetch-patch";
import { installRuntimeFetchPatch, resolveConfigDir, startLazyProxy } from "./runtime";

interface AppLogger {
  log?: (args: {
    body: { service: string; level: string; message: string; extra?: Record<string, unknown> };
  }) => unknown;
}

interface PluginCtx {
  client?: { app?: AppLogger };
}

type Cleanup = () => void | Promise<void>;

/**
 * V2 插件定义：OpenCode 1.18.29+ 的 V2 loader 要求默认导出 `{ id, setup }`。
 * `setup` 的返回值是清理函数（不是 V1 的 `{ dispose }` 对象）。
 */
export interface LazyProxyPluginDefinition {
  id: string;
  setup: (ctx: PluginCtx) => Promise<Cleanup | void>;
  /** V1 兼容入口：旧 loader 会调用 server() 并接收 { dispose }。 */
  server?: (ctx: PluginCtx) => Promise<Record<string, unknown>>;
}

/**
 * opencode 插件入口：进程内 fetch 拦截 + 代理 env 注入 + 懒代理；任何失败只记日志，绝不影响 opencode 本体。
 *
 * 历史坑（导致 "failed to load plugin"）：早期把 SDK 方法解构后裸调用
 * （`const fn = ctx.client.app.log; fn(...)`），`this` 丢失 → 抛
 * "Cannot read properties of undefined (reading '_client')" → 整个插件文件加载失败。
 * 所以：① 日志必须以方法形式调用（`app.log(...)`，保留 receiver）；
 *       ② 日志调用全部兜底，绝不外抛。
 *
 * V2 适配：V2 默认导出必须是 `{ id, setup }`；V1 函数仍保留为 `server()`，
 * 这样同一个 bundle 可同时被 V1（1.18.29+ 的对象入口）和 V2 加载。
 */
export const LazyProxyPlugin = async (ctx: PluginCtx): Promise<Record<string, unknown>> => {
  const cleanup = await activate(ctx);
  return cleanup ? { dispose: cleanup } : {};
};

const plugin: LazyProxyPluginDefinition = {
  id: "lazy-proxy",
  setup: async (ctx) => (await activate(ctx)) ?? undefined,
  server: LazyProxyPlugin,
};

export default plugin;

/** 启动代理并返回清理函数；未配置订阅或启动失败时返回 null（不拖垮 opencode）。 */
async function activate(ctx: PluginCtx): Promise<Cleanup | null> {
  const log = makeSafeLog(ctx);
  try {
    const cfgDir = resolveConfigDir();
    let handle: ShimHandle | null;
    try {
      handle = await startLazyProxy(cfgDir);
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "EADDRINUSE") {
        const cfg = loadConfig(cfgDir);
        const envHandle = acquireProxyEnv(cfg.shimPort);
        const fetchHandle = safeInstallFetchPatch(cfg.shimPort, cfg);
        log(
          "info",
          `shim port ${cfg.shimPort} already in use; assuming an existing shim; proxy env + fetch interception enabled`,
        );
        return async () => {
          try {
            fetchHandle?.restore();
          } catch {
            /* noop */
          }
          envHandle.restore();
        };
      }
      throw e;
    }
    if (!handle) {
      log("warn", `no subscription configured yet; edit ${join(cfgDir, "config.json")}`);
      return null;
    }
    const cfg = loadConfig(cfgDir);
    const envHandle = acquireProxyEnv(handle.port);
    const fetchHandle = safeInstallFetchPatch(handle.port, cfg);
    log(
      "info",
      `shim on 127.0.0.1:${handle.port}; OpenAI traffic goes through the lazy core (in-process fetch interception), all other hosts pass through directly`,
    );
    return async () => {
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
    };
  } catch (e) {
    log("error", `failed to start: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 安装 fetch 补丁；任何失败都不拖垮插件加载 */
function safeInstallFetchPatch(port: number, cfg: LazyProxyConfig): FetchPatchHandle | null {
  try {
    return installRuntimeFetchPatch(resolveConfigDir(), port, cfg);
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
