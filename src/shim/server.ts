import type { LazyProxyConfig } from "../config/schema";
import type { CoreManager } from "../core/manager";
import { forwardViaCore } from "./transport";

export interface ShimHandlers {
  ensureUp: () => Promise<void>;
  onRequestStart: () => void;
  onRequestEnd: () => void;
  log: (msg: string) => void;
}

export function err502(e: unknown): Response {
  const msg = e instanceof Error ? e.message : String(e);
  return Response.json({ error: { message: `lazy-proxy core unavailable: ${msg}` } }, { status: 502 });
}

/**
 * 启动 shim 服务器（仅监听 127.0.0.1）。
 * 每个请求：连接计数 +1 → ensureUp → 经核心转发（流式）→ 流结束计数 -1。
 */
export function startShimServer(
  cfg: LazyProxyConfig,
  core: CoreManager,
): { port: number; close: () => void } {
  const handlers: ShimHandlers = {
    ensureUp: () => core.ensureUp(),
    onRequestStart: () => core.onRequestStart(),
    onRequestEnd: () => core.onRequestEnd(),
    log: (m) => console.log(`[lazy-proxy] ${m}`),
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.shimPort,
    async fetch(request) {
      handlers.onRequestStart();
      try {
        await handlers.ensureUp();
      } catch (e) {
        handlers.onRequestEnd();
        handlers.log(`ensureUp failed: ${e instanceof Error ? e.message : e}`);
        return err502(e);
      }
      try {
        const res = await forwardViaCore(request, { corePort: cfg.corePort, upstream: cfg.upstream });
        if (!res.body) {
          throw new Error("empty upstream body");
        }
        const [a, b] = res.body.tee();
        void (async () => {
          const reader = b.getReader();
          try {
            while (!(await reader.read()).done) {
              /* drain the tee branch */
            }
          } catch {
            /* client cancelled upstream — treat as ended */
          } finally {
            handlers.onRequestEnd();
          }
        })();
        return new Response(a, { status: res.status, headers: res.headers });
      } catch (e) {
        handlers.onRequestEnd();
        handlers.log(`forward failed: ${e instanceof Error ? e.message : e}`);
        return err502(e);
      }
    },
  });

  return { port: server.port!, close: () => server.stop() };
}
