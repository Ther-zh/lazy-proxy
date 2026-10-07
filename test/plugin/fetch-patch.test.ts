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
function startFakeShim(mode: "ok" | "502" = "ok"): Promise<FakeShim> {
  const connects: string[] = [];
  const requests: FakeShim["requests"] = [];
  const server = createTcpServer((socket: Socket) => {
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
          if (mode === "502") {
            const body = JSON.stringify({ error: { message: "lazy-proxy core unavailable: boom" } });
            socket.end(
              `HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
            );
            phase = "done";
            return;
          }
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
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
      resolve({ port, connects, requests, stop: () => server.close() });
    });
  });
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

  it("rejects with the shim error message when the core tunnel fails (502)", async () => {
    const shim = await startFakeShim("502");
    cleanups.push(shim.stop);
    const scope: FetchScope = { fetch: markerFetch().fetch };
    const patch = installFetchPatch({ shimPort: shim.port, hosts: ["proxied.test"], scope });
    cleanups.push(patch.restore);

    await expect(scope.fetch!("http://proxied.test/x")).rejects.toThrow(/core unavailable: boom/);
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
