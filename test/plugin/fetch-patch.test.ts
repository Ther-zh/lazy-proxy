import { createServer as createTcpServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { installFetchPatch, type FetchScope } from "../../src/plugin/fetch-patch";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface FakeShim {
  port: number;
  connects: string[];
  requests: Array<{ head: string; body: string }>;
  stop: () => void;
}

/**
 * 极简假 shim：
 *  - ok 模式：解析 CONNECT → 回 200 → 记录随后的 HTTP 请求 → 回固定响应；
 *  - 502 模式：直接回 shim 风格的核心错误（JSON body + connection: close）。
 */
function startFakeShim(
  mode: "ok" | "502" | "connectSilent" | "tunnelSilent" | "tunnelGarbage" | "flaky" = "ok",
  opts: { failFirst?: number } = {},
): Promise<FakeShim> {
  const connects: string[] = [];
  const requests: FakeShim["requests"] = [];
  const sockets = new Set<Socket>();
  let connectCount = 0;
  let server: ReturnType<typeof createTcpServer>;
  server = createTcpServer((socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    let phase: "head" | "innerHead" | "innerBody" | "done" = "head";
    let innerHead = "";
    let need = 0;
    socket.on("error", () => {
      /* noop */
    });
    const consume = () => {
      while (phase !== "done") {
        if (phase === "head") {
          const idx = buf.indexOf("\r\n\r\n");
          if (idx === -1) return;
          const head = buf.subarray(0, idx).toString("latin1");
          buf = buf.subarray(idx + 4);
          connects.push(/^CONNECT (\S+)/i.exec(head)?.[1] ?? "");
          connectCount++;
          if (mode === "flaky" && connectCount <= (opts.failFirst ?? 0)) {
            const body = JSON.stringify({ error: { message: "lazy-proxy core unavailable: flaky" } });
            socket.end(
              `HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
            );
            phase = "done";
            return;
          }
          if (mode === "connectSilent") {
            phase = "done";
            return;
          }
          if (mode === "502") {
            const body = JSON.stringify({ error: { message: "lazy-proxy core unavailable: boom" } });
            socket.end(
              `HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
            );
            phase = "done";
            return;
          }
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (mode === "tunnelSilent") {
            phase = "done";
            return;
          }
          if (mode === "tunnelGarbage") {
            setTimeout(() => {
              if (!socket.destroyed) socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            }, 10);
            phase = "done";
            return;
          }
          phase = "innerHead";
        } else if (phase === "innerHead") {
          const idx = buf.indexOf("\r\n\r\n");
          if (idx === -1) return;
          innerHead = buf.subarray(0, idx).toString("latin1");
          buf = buf.subarray(idx + 4);
          need = Number(/content-length: (\d+)/i.exec(innerHead)?.[1] ?? 0);
          phase = "innerBody";
        } else if (phase === "innerBody") {
          if (buf.length < need) return;
          const body = buf.subarray(0, need).toString("utf8");
          buf = buf.subarray(need);
          requests.push({ head: innerHead, body });
          const payload = "hello";
          socket.write(
            `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${payload.length}\r\nconnection: close\r\n\r\n${payload}`,
          );
          socket.end();
          phase = "done";
        }
      }
    };
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      consume();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        port,
        connects,
        requests,
        stop: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}

/** 取 promise 的 rejection，并展开 cause 链（插件现在统一抛 fetch failed） */
async function failureOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected rejection");
}

function fullError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    parts.push(cur instanceof Error ? `${cur.name}: ${cur.message}` : String(cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

/** 给 fetch 加一个"必须在时限内失败"的看门狗，避免 RED 阶段等到默认 30s */
function withWatchdog<T>(p: Promise<T>, ms = 1500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("watchdog: no timeout applied")), ms)),
  ]);
}

function markerFetch(): { fetch: typeof fetch; calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = (async (...args: unknown[]) => {
    calls.push(args);
    return new Response("orig", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

describe("installFetchPatch", () => {
  it("tunnels whitelisted hosts through the shim without calling the original fetch", async () => {
    const shim = await startFakeShim("ok");
    cleanups.push(shim.stop);
    const orig = markerFetch();
    const scope: FetchScope = { fetch: orig.fetch };
    const patch = installFetchPatch({ shimPort: shim.port, hosts: ["proxied.test"], scope });
    cleanups.push(patch.restore);

    const res = await scope.fetch!("http://proxied.test/hello?x=1");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(shim.connects).toEqual(["proxied.test:80"]);
    expect(orig.calls).toHaveLength(0);
  });

  it("matches subdomains of whitelisted hosts", async () => {
    const shim = await startFakeShim("ok");
    cleanups.push(shim.stop);
    const scope: FetchScope = { fetch: markerFetch().fetch };
    const patch = installFetchPatch({ shimPort: shim.port, hosts: ["proxied.test"], scope });
    cleanups.push(patch.restore);

    const res = await scope.fetch!("http://sub.proxied.test/x");
    expect(res.status).toBe(200);
    expect(shim.connects).toEqual(["sub.proxied.test:80"]);
  });

  it("forwards method, headers and body through the tunnel", async () => {
    const shim = await startFakeShim("ok");
    cleanups.push(shim.stop);
    const scope: FetchScope = { fetch: markerFetch().fetch };
    const patch = installFetchPatch({ shimPort: shim.port, hosts: ["proxied.test"], scope });
    cleanups.push(patch.restore);

    const res = await scope.fetch!("http://proxied.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(shim.requests).toHaveLength(1);
    const req = shim.requests[0]!;
    expect(req.head).toMatch(/^POST \/v1\/responses HTTP\/1\.1/);
    expect(req.head.toLowerCase()).toContain("content-type: application/json");
    expect(req.body).toBe("{}");
  });

  it("passes non-whitelisted urls to the original fetch untouched", async () => {
    const shim = await startFakeShim("ok");
    cleanups.push(shim.stop);
    const orig = markerFetch();
    const scope: FetchScope = { fetch: orig.fetch };
    const patch = installFetchPatch({ shimPort: shim.port, hosts: ["proxied.test"], scope });
    cleanups.push(patch.restore);

    const res = await scope.fetch!("http://other.test/data");
    expect(await res.text()).toBe("orig");
    expect(orig.calls).toHaveLength(1);
    expect(shim.connects).toHaveLength(0);
  });

  it("surfaces proxy failures as retryable fetch failures (TypeError + cause)", async () => {
    const shim = await startFakeShim("502");
    cleanups.push(shim.stop);
    const scope: FetchScope = { fetch: markerFetch().fetch };
    const patch = installFetchPatch({ shimPort: shim.port, hosts: ["proxied.test"], scope });
    cleanups.push(patch.restore);

    let caught: unknown;
    try {
      await scope.fetch!("http://proxied.test/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe("fetch failed");
    const cause = (caught as { cause?: { message?: string } }).cause;
    expect(String(cause?.message)).toMatch(/core unavailable: boom/);
    // 未配置 retry 时只尝试一次
    expect(shim.connects).toHaveLength(1);
  });

  it("retries transient tunnel failures until success (retryForever)", async () => {
    const shim = await startFakeShim("flaky", { failFirst: 2 });
    cleanups.push(shim.stop);
    const scope: FetchScope = { fetch: markerFetch().fetch };
    const patch = installFetchPatch({
      shimPort: shim.port,
      hosts: ["proxied.test"],
      scope,
      retry: { forever: true, delayMs: 10, maxDelayMs: 20 },
    });
    cleanups.push(patch.restore);

    const res = await withWatchdog(scope.fetch!("http://proxied.test/x"), 5000);
    expect(await res.text()).toBe("hello");
    expect(shim.connects).toHaveLength(3);
  });

  it("stops retrying when the caller aborts", async () => {
    const shim = await startFakeShim("connectSilent");
    cleanups.push(shim.stop);
    const scope: FetchScope = { fetch: markerFetch().fetch };
    const patch = installFetchPatch({
      shimPort: shim.port,
      hosts: ["proxied.test"],
      scope,
      retry: { forever: true, delayMs: 10, maxDelayMs: 20 },
    });
    cleanups.push(patch.restore);

    const ac = new AbortController();
    const p = scope.fetch!("http://proxied.test/x", { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await expect(withWatchdog(p, 2000)).rejects.toMatchObject({ name: "AbortError" });
    expect(shim.connects.length).toBeGreaterThanOrEqual(1);
  });

  it("reports a CONNECT timeout when the shim never answers", async () => {
    const shim = await startFakeShim("connectSilent");
    cleanups.push(shim.stop);
    const scope: FetchScope = { fetch: markerFetch().fetch };
    const patch = installFetchPatch({
      shimPort: shim.port,
      hosts: ["proxied.test"],
      scope,
      timeouts: { connectMs: 80 },
    });
    cleanups.push(patch.restore);

    const err = await failureOf(withWatchdog(scope.fetch!("http://proxied.test/x")));
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("fetch failed");
    expect(fullError(err)).toMatch(/did not answer CONNECT/);
  });

  it("reports a TLS handshake timeout when the tunnel stalls after CONNECT", async () => {
    const shim = await startFakeShim("tunnelSilent");
    cleanups.push(shim.stop);
    const scope: FetchScope = { fetch: markerFetch().fetch };
    const patch = installFetchPatch({
      shimPort: shim.port,
      hosts: ["proxied.test"],
      scope,
      timeouts: { connectMs: 500, tlsMs: 80 },
    });
    cleanups.push(patch.restore);

    const err = await failureOf(withWatchdog(scope.fetch!("https://proxied.test/x")));
    expect(err).toBeInstanceOf(TypeError);
    expect(fullError(err)).toMatch(/TLS handshake did not complete/);
  });

  it("classifies TLS handshake failures through the proxy", async () => {
    const shim = await startFakeShim("tunnelGarbage");
    cleanups.push(shim.stop);
    const scope: FetchScope = { fetch: markerFetch().fetch };
    const patch = installFetchPatch({ shimPort: shim.port, hosts: ["proxied.test"], scope });
    cleanups.push(patch.restore);

    const err = await failureOf(withWatchdog(scope.fetch!("https://proxied.test/x")));
    expect(err).toBeInstanceOf(TypeError);
    expect(fullError(err)).toMatch(/TLS handshake via proxy failed/);
  });

  it("install is idempotent; restore only when the last handle is released", async () => {
    const shim = await startFakeShim("ok");
    cleanups.push(shim.stop);
    const orig = markerFetch();
    const scope: FetchScope = { fetch: orig.fetch };
    const h1 = installFetchPatch({ shimPort: shim.port, hosts: ["proxied.test"], scope });
    const patched = scope.fetch;
    const h2 = installFetchPatch({ shimPort: shim.port, hosts: ["proxied.test"], scope });
    expect(scope.fetch).toBe(patched);

    h1.restore();
    expect(scope.fetch).toBe(patched);
    h2.restore();
    expect(scope.fetch).toBe(orig.fetch);
  });
});
