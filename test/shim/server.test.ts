import { describe, expect, it } from "vitest";
import { startShimServer } from "../../src/shim/server";
import { CoreManager } from "../../src/core/manager";
import type { LazyProxyConfig } from "../../src/config/schema";
import { startFakeCoreProxy } from "../fixtures/fake-core";
import { DEFAULTS } from "../../src/config/schema";

const cfgOf = (over: Partial<LazyProxyConfig>): LazyProxyConfig => ({
  subscriptionUrl: "https://sub.example.com/api?token=x",
  shimPort: 0,
  corePort: 17890,
  idleMs: 180_000,
  mihomoVersion: DEFAULTS.mihomoVersion,
  upstream: "https://api.openai.com",
  logLevel: "info",
  ...over,
});

/** 造一个"已就绪"的核心（isPortReady 恒真 → 视为外部核心，不 spawn） */
function readyCore(): CoreManager {
  const core = new CoreManager(cfgOf({}), "C:/data", {
    ensureBinary: async () => "C:/fake/mihomo.exe",
    ensureConfig: async () => "C:/fake/config.yaml",
    spawn: () => ({ pid: 1, onExit() {}, kill() {} }),
    isPortReady: async () => true,
    killTree() {},
    now: () => Date.now(),
  });
  return core;
}

/** 假上游：OpenAI 风格回显 + SSE 流 */
async function startUpstream(): Promise<{ port: number; lastAuth: () => string | null; stop: () => void }> {
  let auth: string | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      auth = req.headers.get("authorization");
      const u = new URL(req.url);
      if (u.pathname === "/v1/stream") {
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            const t = new TextEncoder();
            c.enqueue(t.encode(`data: {"content":"event1"}\n\n`));
            await Bun.sleep(30);
            c.enqueue(t.encode(`data: {"content":"event2"}\n\n`));
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        ok: true,
        auth,
        hasCustom: req.headers.get("x-custom"),
        path: u.pathname,
      });
    },
  });
  return { port: server.port!, lastAuth: () => auth, stop: () => server.stop() };
}

describe("shim server integration", () => {
  it("forwards POST through fake core and streams SSE with correct lifecycle", async () => {
    const up = await startUpstream();
    const coreProxy = await startFakeCoreProxy(0);
    const core = readyCore();
    let starts = 0;
    let ends = 0;
    core.onRequestStart = () => {
      starts++;
    };
    core.onRequestEnd = () => {
      ends++;
    };
    const shim = startShimServer(
      cfgOf({ corePort: coreProxy.port, upstream: `http://127.0.0.1:${up.port}` }),
      core,
    );

    // POST 非流式
    const res = await fetch(`http://127.0.0.1:${shim.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-test-123",
        "content-type": "application/json",
        "x-custom": "yes",
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; auth: string | null; hasCustom: string | null; path: string };
    expect(j.ok).toBe(true);
    expect(j.auth).toBe("Bearer sk-test-123");
    expect(j.hasCustom).toBe("yes");
    expect(j.path).toBe("/v1/chat/completions");
    expect(coreProxy.hits()).toBeGreaterThanOrEqual(1);

    // SSE 流式
    const sse = await fetch(`http://127.0.0.1:${shim.port}/v1/stream`);
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const sseText = await sse.text();
    expect(sseText).toContain("event1");
    expect(sseText).toContain("event2");

    // 生命周期：请求结束后计数归零
    expect(starts).toBe(2);
    expect(ends).toBe(2);

    shim.close();
    serverStop(up);
    serverStop(coreProxy);
  });

  it("returns 502 and decrements when core cannot start", async () => {
    const up = await startUpstream();
    const coreProxy = await startFakeCoreProxy(0);
    const broken: any = {
      ensureUp: async () => {
        throw new Error("core boom");
      },
      onRequestStart() {},
      onRequestEnd() {},
    };
    const shim = startShimServer(cfgOf({ corePort: coreProxy.port, upstream: `http://127.0.0.1:${up.port}` }), broken);
    const res = await fetch(`http://127.0.0.1:${shim.port}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(502);
    const j = (await res.json()) as { error: { message: string } };
    expect(j.error.message).toContain("core boom");
    shim.close();
    serverStop(up);
    serverStop(coreProxy);
  });
});

function serverStop(s: { stop: () => void }): void {
  try {
    s.stop();
  } catch {
    /* noop */
  }
}
