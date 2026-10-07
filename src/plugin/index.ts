import { join } from "node:path";
import { resolveConfigDir, startLazyProxy } from "./runtime";

interface PluginCtx {
  client?: {
    app?: {
      log?: (args: {
        body: { service: string; level: string; message: string; extra?: Record<string, unknown> };
      }) => Promise<unknown>;
    };
  };
}

/**
 * opencode 插件入口：启动懒代理；任何失败只记日志，绝不影响 opencode 本体。
 *
 * 重要：本文件只导出这一个插件函数。opencode 会把插件文件里导出的
 * 每一个函数都当作插件加载，若此处 re-export 了 resolveConfigDir /
 * startLazyProxy 等辅助函数，加载器会将其当作插件调用并崩溃
 * （Cannot read properties of undefined (reading '_client')），导致整个插件文件加载失败。
 */
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
