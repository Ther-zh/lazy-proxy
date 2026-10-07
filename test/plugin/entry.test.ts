import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect as netConnect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LazyProxyPlugin } from "../../src/plugin/index";
import { resolveConfigDir, startLazyProxy } from "../../src/plugin/runtime";

const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"] as const;
const savedEnv = new Map<string, string | undefined>();

function saveEnv(): void {
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
}

function clearProxyEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lazyproxy-plug-"));
}

function tempDirWithConfig(over: Record<string, unknown> = {}): string {
  const dir = tempDir();
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      subscriptionUrl: "https://sub.example.com/api?token=x",
      shimPort: 0,
      corePort: 17890,
      ...over,
    }),
    "utf8",
  );
  return dir;
}

/** 模拟 @opencode-ai/sdk 的 client：app.log 依赖 this._client（解构裸调用会崩） */
function sdkLikeCtx(): { ctx: { client: { app: unknown } }; posted: unknown[] } {
  const posted: unknown[] = [];
  const app = {
    _client: {
      post: async (args: unknown) => {
        posted.push(args);
        return {};
      },
    },
    async log(args: { body: { level: string; message: string } }) {
      return this._client.post(args);
    },
  };
  return { ctx: { client: { app } }, posted };
}

/** 分配一个空闲本地端口（避免测试误用默认 17891 撞上真实实例） */
async function freePort(): Promise<number> {
  const srv = createTcpServer(() => {
    /* just to reserve */
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const p = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return p;
}

function withConfigDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.LAZYPROXY_CONFIG_DIR;
  process.env.LAZYPROXY_CONFIG_DIR = dir;
  return fn().finally(() => {
    if (old === undefined) delete process.env.LAZYPROXY_CONFIG_DIR;
    else process.env.LAZYPROXY_CONFIG_DIR = old;
  });
}

describe("plugin entry", () => {
  afterEach(() => restoreEnv());

  it("exports an async plugin function", () => {
    expect(typeof LazyProxyPlugin).toBe("function");
    expect(LazyProxyPlugin.constructor.name).toBe("AsyncFunction");
  });

  it("resolveConfigDir honors env override", () => {
    const old = process.env.LAZYPROXY_CONFIG_DIR;
    process.env.LAZYPROXY_CONFIG_DIR = "C:/tmp/lazyproxy-cfg";
    expect(resolveConfigDir()).toBe("C:/tmp/lazyproxy-cfg");
    if (old === undefined) delete process.env.LAZYPROXY_CONFIG_DIR;
    else process.env.LAZYPROXY_CONFIG_DIR = old;
  });

  it("startLazyProxy returns null and writes default config when subscription missing", async () => {
    const dir = tempDir();
    const h = await startLazyProxy(dir);
    expect(h).toBeNull();
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toContain("subscriptionUrl");
    rmSync(dir, { recursive: true, force: true });
  });

  it("plugin runs without throwing when config is missing", async () => {
    const dir = tempDir();
    await expect(withConfigDir(dir, () => LazyProxyPlugin({} as never))).resolves.toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });

  it("calls SDK-like client.app.log with bound receiver and resolves", async () => {
    saveEnv();
    const dir = tempDir();
    const { ctx, posted } = sdkLikeCtx();
    const result = await withConfigDir(dir, () => LazyProxyPlugin(ctx as never));
    expect(result).toEqual({});
    expect(posted).toHaveLength(1);
    const body = (posted[0] as { body: { service: string; level: string } }).body;
    expect(body.service).toBe("lazy-proxy");
    expect(body.level).toBe("warn");
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves even when client.app.log always throws", async () => {
    saveEnv();
    const dir = tempDir();
    const ctx = {
      client: {
        app: {
          async log(): Promise<void> {
            throw new Error("log exploded");
          },
        },
      },
    };
    await expect(withConfigDir(dir, () => LazyProxyPlugin(ctx as never))).resolves.toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });

  it("injects proxy env pointing at the shim and dispose closes + restores", async () => {
    saveEnv();
    clearProxyEnv();
    const origFetch = globalThis.fetch;
    const chosen = await freePort();
    const dir = tempDirWithConfig({ shimPort: chosen });
    const { ctx } = sdkLikeCtx();
    const result = (await withConfigDir(dir, () => LazyProxyPlugin(ctx as never))) as {
      dispose?: () => Promise<void>;
    };
    const proxy = process.env.HTTPS_PROXY ?? "";
    expect(proxy).toBe(`http://127.0.0.1:${chosen}`);
    expect(globalThis.fetch).not.toBe(origFetch);
    const port = chosen;
    expect(process.env.http_proxy).toBe(proxy);
    expect(process.env.HTTP_PROXY).toBe(proxy);
    expect(process.env.NO_PROXY).toContain("localhost");

    const alive = await new Promise<boolean>((resolve) => {
      const s = netConnect({ host: "127.0.0.1", port });
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    expect(alive).toBe(true);

    expect(typeof result.dispose).toBe("function");
    await result.dispose!();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(globalThis.fetch).toBe(origFetch);

    const closed = await new Promise<boolean>((resolve) => {
      const s = netConnect({ host: "127.0.0.1", port });
      s.once("connect", () => {
        s.destroy();
        resolve(false);
      });
      s.once("error", () => resolve(true));
    });
    expect(closed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("EADDRINUSE: still injects env pointing at the configured shim port", async () => {
    saveEnv();
    clearProxyEnv();
    const origFetch = globalThis.fetch;
    const occupied = createTcpServer(() => {
      /* hold the port */
    });
    await new Promise<void>((r) => occupied.listen(0, "127.0.0.1", r));
    const occPort = (occupied.address() as { port: number }).port;
    const dir = tempDirWithConfig({ shimPort: occPort });
    const { ctx } = sdkLikeCtx();
    const result = (await withConfigDir(dir, () => LazyProxyPlugin(ctx as never))) as {
      dispose?: () => Promise<void>;
    };
    expect(process.env.HTTPS_PROXY).toBe(`http://127.0.0.1:${occPort}`);
    expect(globalThis.fetch).not.toBe(origFetch);
    await result.dispose?.();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(globalThis.fetch).toBe(origFetch);
    occupied.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
