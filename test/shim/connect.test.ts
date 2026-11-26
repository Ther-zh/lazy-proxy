import { connect as netConnect, createServer as createTcpServer, Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { effectiveProxyHosts, isProxyHost, startShimServer } from "../../src/shim/server";
import { CoreManager } from "../../src/core/manager";
import { DEFAULTS, type LazyProxyConfig } from "../../src/config/schema";
import { startFakeCoreProxy } from "../fixtures/fake-core";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const cfgOf = (over: Partial<LazyProxyConfig>): LazyProxyConfig => ({
  subscriptionUrl: "https://sub.example.com/api?token=x",
  shimPort: 0,
  corePort: 17890,
  idleMs: 180_000,
  mihomoVersion: DEFAULTS.mihomoVersion,
  upstream: "https://api.openai.com",
  proxyHosts: [...DEFAULTS.proxyHosts],
  logLevel: "info",
  ...over,
});

function readyCore(): CoreManager {
  return new CoreManager(cfgOf({}), "C:/data", {
    ensureBinary: async () => "C:/fake/mihomo.exe",
    ensureConfig: async () => "C:/fake/config.yaml",
    spawn: () => ({ pid: 1, onExit() {}, kill() {} }),
    isPortReady: async () => true,
    killTree() {},
    now: () => Date.now(),
  });
}

/** 向 shim 发 CONNECT 并等握手响应头 */
function connectTunnel(
  shimPort: number,
  target: string,
  deadlineMs = 5000,
): Promise<{ status: number; socket: Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host: "127.0.0.1", port: shimPort });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error("CONNECT handshake timed out"));
    }, deadlineMs);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      clearTimeout(timer);
      s.removeListener("data", onData);
      const line = buf.subarray(0, idx).toString("latin1").split("\r\n")[0];
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(line);
      resolve({ status: m ? Number(m[1]) : 0, socket: s, rest: buf.subarray(idx + 4) });
    };
    s.on("data", onData);
    s.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    s.once("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  });
}

/** 在 socket 上累计读取 n 字节（initial 为已缓冲的剩余字节） */
function readBytes(s: Socket, n: number, initial: Buffer): Promise<Buffer> {
  return new Promise((resolve) => {
    let acc = initial;
    if (acc.length >= n) {
      resolve(acc);
      return;
    }
    const onData = (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk]);
      if (acc.length >= n) {
        s.removeListener("data", onData);
        resolve(acc);
      }
    };
    s.on("data", onData);
  });
}

async function startEchoTcp(): Promise<{ port: number; stop: () => void }> {
  const server = createTcpServer((s) => s.pipe(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { port, stop: () => server.close() };
}

/** 收到 CONNECT 后回 200，随即 RST —— 复现“隧道建立后 core 异常断开” */
async function startResettingCore(): Promise<{ port: number; stop: () => void }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      /* noop */
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.indexOf("\r\n\r\n") === -1) return;
      socket.removeListener("data", onData);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      setTimeout(() => socket.resetAndDestroy(), 30);
    };
    socket.on("data", onData);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    port,
    stop: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/** 接受 TCP 但永不应答 CONNECT —— 复现“core 卡死” */
async function startSilentCore(): Promise<{ port: number; stop: () => void }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      /* noop */
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    port,
    stop: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/** 收集一段时间内 socket 收到的字节（含已缓冲的 rest） */
function collectFor(socket: Socket, initial: Buffer, ms: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let acc = initial;
    const onData = (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk]);
    };
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      socket.removeListener("data", onData);
      resolve(acc);
    };
    socket.on("data", onData);
    socket.once("close", done);
    setTimeout(done, ms);
  });
}

describe("isProxyHost / effectiveProxyHosts", () => {
  it("matches exact hosts and suffixes on dot boundary", () => {
    const wl = ["chatgpt.com", "openai.com"];
    expect(isProxyHost("chatgpt.com", wl)).toBe(true);
    expect(isProxyHost("api.openai.com", wl)).toBe(true);
    expect(isProxyHost("CHATGPT.COM", wl)).toBe(true);
    expect(isProxyHost("chatgpt.com.evil.com", wl)).toBe(false);
    expect(isProxyHost("xopenai.com", wl)).toBe(false);
    expect(isProxyHost("deepseek.com", wl)).toBe(false);
  });

  it("includes the upstream host automatically", () => {
    const cfg = cfgOf({ upstream: "https://api.openai.com", proxyHosts: ["chatgpt.com"] });
    const wl = effectiveProxyHosts(cfg);
    expect(wl).toContain("chatgpt.com");
    expect(wl).toContain("api.openai.com");
  });
});

describe("CONNECT tunneling", () => {
  it("routes whitelisted host through the core (lazy ensureUp) and tunnels bytes", async () => {
    const coreProxy = await startFakeCoreProxy(0);
    const core = readyCore();
    let ensureUps = 0;
    let starts = 0;
    let ends = 0;
    core.ensureUp = async () => {
      ensureUps++;
    };
    core.onRequestStart = () => {
      starts++;
    };
    core.onRequestEnd = () => {
      ends++;
    };
    const shim = await startShimServer(cfgOf({ corePort: coreProxy.port }), core);

    const t = await connectTunnel(shim.port, "chatgpt.com:443");
    expect(t.status).toBe(200);
    t.socket.write("ping");
    const echoed = await readBytes(t.socket, 4, t.rest);
    expect(echoed.subarray(0, 4).toString("latin1")).toBe("ping");
    expect(coreProxy.connectHits()).toBe(1);
    expect(ensureUps).toBe(1);
    expect(starts).toBe(1);
    t.socket.destroy();
    await sleep(50);
    expect(ends).toBe(1);

    shim.close();
    coreProxy.stop();
  });

  it("passes non-whitelisted host through directly without touching the core", async () => {
    const echo = await startEchoTcp();
    const coreProxy = await startFakeCoreProxy(0);
    const core = readyCore();
    let ensureUps = 0;
    core.ensureUp = async () => {
      ensureUps++;
    };
    const shim = await startShimServer(cfgOf({ corePort: coreProxy.port }), core);

    const t = await connectTunnel(shim.port, `127.0.0.1:${echo.port}`);
    expect(t.status).toBe(200);
    t.socket.write("hello");
    const echoed = await readBytes(t.socket, 5, t.rest);
    expect(echoed.subarray(0, 5).toString("latin1")).toBe("hello");
    expect(ensureUps).toBe(0);
    expect(coreProxy.connectHits()).toBe(0);

    t.socket.destroy();
    shim.close();
    coreProxy.stop();
    echo.stop();
  });

  it("returns 502 when ensureUp fails for a whitelisted host", async () => {
    const core = readyCore();
    core.ensureUp = async () => {
      throw new Error("core boom");
    };
    const shim = await startShimServer(cfgOf({}), core);
    const t = await connectTunnel(shim.port, "api.openai.com:443");
    expect(t.status).toBe(502);
    expect(t.rest.toString("utf8")).toContain("core boom");
    t.socket.destroy();
    shim.close();
  });

  it("never writes plaintext HTTP after the tunnel is established (core resets mid-TLS)", async () => {
    const misbehaving = await startResettingCore();
    const core = readyCore();
    core.ensureUp = async () => {};
    const shim = await startShimServer(cfgOf({ corePort: misbehaving.port }), core);

    const t = await connectTunnel(shim.port, "chatgpt.com:443");
    expect(t.status).toBe(200);
    const after = await collectFor(t.socket, t.rest, 300);
    expect(after.toString("latin1")).not.toContain("502");
    expect(after.length).toBe(0);

    t.socket.destroy();
    shim.close();
    misbehaving.stop();
  });

  it("flushes pending client writes when the core ends the tunnel gracefully", async () => {
    const payload = Buffer.alloc(256 * 1024, 0x5a);
    const sockets = new Set<Socket>();
    const coreProxy = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let headers = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        headers = Buffer.concat([headers, chunk]);
        if (headers.indexOf("\r\n\r\n") < 0) return;
        socket.removeListener("data", onData);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.end(payload);
      };
      socket.on("data", onData);
    });
    await new Promise<void>((resolve) => coreProxy.listen(0, "127.0.0.1", resolve));
    const core = readyCore();
    core.ensureUp = async () => {};
    const corePort = (coreProxy.address() as { port: number }).port;
    const shim = await startShimServer(cfgOf({ corePort }), core);

    // Hold writes only on this shim's client socket. This makes the real TCP
    // backpressure race deterministic without changing any tunnel events.
    const originalPipe = Socket.prototype.pipe;
    const pipeSpy = vi.spyOn(Socket.prototype, "pipe").mockImplementation(function <T extends NodeJS.WritableStream>(
      this: Socket,
      destination: T,
      options?: { end?: boolean },
    ): T {
      if (this.remotePort === corePort && (destination as unknown as Socket).localPort === shim.port) {
        // Bun's HTTP CONNECT socket has its own _write implementation, so
        // delay this actual instance rather than the net.Socket prototype.
        const downstream = destination as unknown as Socket;
        const write = downstream._write;
        downstream._write = function (...args: Parameters<typeof write>) {
          setTimeout(() => write.apply(this, args), 30);
        };
        const writev = downstream._writev;
        if (writev) downstream._writev = function (...args: Parameters<typeof writev>) {
          setTimeout(() => writev.apply(this, args), 30);
        };
      }
      return originalPipe.call(this, destination, options) as T;
    });
    let client: Socket | undefined;
    try {
      const tunnel = await connectTunnel(shim.port, "chatgpt.com:443");
      client = tunnel.socket;
      expect(tunnel.status).toBe(200);
      const received = await new Promise<Buffer>((resolve, reject) => {
        const chunks = [tunnel.rest];
        const timer = setTimeout(() => reject(new Error("tunnel did not close")), 3000);
        client!.on("data", (chunk: Buffer) => chunks.push(chunk));
        client!.once("error", reject);
        client!.once("close", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        });
      });
      expect(received.length).toBe(payload.length);
      expect(received.equals(payload)).toBe(true);
    } finally {
      pipeSpy.mockRestore();
      client?.destroy();
      shim.close();
      for (const socket of sockets) socket.destroy();
      coreProxy.close();
    }
  });

  it("returns 502 when the core never answers CONNECT (timeout)", async () => {
    const silent = await startSilentCore();
    const core = readyCore();
    core.ensureUp = async () => {};
    const shim = await startShimServer(cfgOf({ corePort: silent.port }), core, {
      coreConnectTimeoutMs: 100,
    });

    const t = await connectTunnel(shim.port, "chatgpt.com:443", 2000);
    expect(t.status).toBe(502);
    expect(t.rest.toString("utf8")).toMatch(/CONNECT/i);
    t.socket.destroy();
    shim.close();
    silent.stop();
  });

  it("keeps a healthy tunnel open after the CONNECT timeout window elapses", async () => {
    const coreProxy = await startFakeCoreProxy(0);
    const core = readyCore();
    core.ensureUp = async () => {};
    const shim = await startShimServer(cfgOf({ corePort: coreProxy.port }), core, {
      coreConnectTimeoutMs: 50,
    });

    const t = await connectTunnel(shim.port, "chatgpt.com:443");
    expect(t.status).toBe(200);
    await sleep(120);
    t.socket.write("ping");
    const echoed = await readBytes(t.socket, 4, t.rest);
    expect(echoed.subarray(0, 4).toString("latin1")).toBe("ping");

    t.socket.destroy();
    shim.close();
    coreProxy.stop();
  });
});
