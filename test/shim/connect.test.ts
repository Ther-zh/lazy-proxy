import { connect as netConnect, createServer as createTcpServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
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
): Promise<{ status: number; socket: Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host: "127.0.0.1", port: shimPort });
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      s.removeListener("data", onData);
      const line = buf.subarray(0, idx).toString("latin1").split("\r\n")[0];
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(line);
      resolve({ status: m ? Number(m[1]) : 0, socket: s, rest: buf.subarray(idx + 4) });
    };
    s.on("data", onData);
    s.once("error", reject);
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
});
