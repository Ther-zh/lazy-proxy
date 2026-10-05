import { describe, expect, it } from "vitest";
import { CoreManager, type CoreManagerDeps, type SpawnedProcess } from "../../src/core/manager";
import type { LazyProxyConfig } from "../../src/config/schema";
import { DEFAULTS } from "../../src/config/schema";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const baseCfg: LazyProxyConfig = {
  subscriptionUrl: "https://sub.example.com/api?token=x",
  shimPort: 17891,
  corePort: 17890,
  idleMs: 180_000,
  mihomoVersion: "v1.19.32",
  upstream: DEFAULTS.upstream,
  logLevel: "info",
};

interface FakeCtx {
  deps: CoreManagerDeps;
  child: SpawnedProcess;
  spawnCalls: number;
  killPids: number[];
  binaryCalls: number;
  configCalls: number;
  emitExit: (code: number | null, signal: string | null) => void;
  setExternal: (v: boolean) => void;
  setPost: (v: boolean) => void;
  setNow: (n: number) => void;
}

function makeCtx(): FakeCtx {
  let now = 1_000_000;
  let externalReady = false;
  let postReady = true;
  let checks = 0;
  const listeners = new Set<(code: number | null, sig: string | null) => void>();
  const child: SpawnedProcess = {
    pid: 4242,
    onExit: (l) => {
      listeners.add(l);
    },
    kill: () => {},
  };
  const ctx: FakeCtx = {
    spawnCalls: 0,
    killPids: [],
    binaryCalls: 0,
    configCalls: 0,
    child,
    emitExit: (c, s) => {
      for (const l of [...listeners]) l(c, s);
    },
    setExternal: (v) => {
      externalReady = v;
    },
    setPost: (v) => {
      postReady = v;
    },
    setNow: (n) => {
      now = n;
    },
    deps: {
      ensureBinary: async () => {
        ctx.binaryCalls++;
        return "C:/fake/mihomo.exe";
      },
      ensureConfig: async () => {
        ctx.configCalls++;
        return "C:/fake/config.yaml";
      },
      spawn: () => {
        ctx.spawnCalls++;
        return child;
      },
      isPortReady: async (_port: number, timeoutMs: number) => {
        checks++;
        return timeoutMs <= 1000 ? externalReady : postReady;
      },
      killTree: (pid) => {
        ctx.killPids.push(pid);
      },
      now: () => now,
    },
  };
  return ctx;
}

describe("CoreManager", () => {
  it("starts core on first ensureUp, single spawn, reuses while running", async () => {
    const ctx = makeCtx();
    const m = new CoreManager(baseCfg, "C:/data", ctx.deps);
    await m.ensureUp();
    expect(m.state).toBe("running");
    expect(ctx.spawnCalls).toBe(1);
    expect(ctx.binaryCalls).toBe(1);
    expect(ctx.configCalls).toBe(1);
    await m.ensureUp();
    expect(ctx.spawnCalls).toBe(1);
    m.idle.dispose();
  });

  it("detects external core and never spawns or kills", async () => {
    const ctx = makeCtx();
    ctx.setExternal(true);
    const m = new CoreManager(baseCfg, "C:/data", ctx.deps);
    await m.ensureUp();
    expect(m.state).toBe("running");
    expect(m.external).toBe(true);
    expect(ctx.spawnCalls).toBe(0);
    await m.stop();
    expect(ctx.killPids).toHaveLength(0);
    expect(m.state).toBe("running");
    m.idle.dispose();
  });

  it("fails on start timeout and kills the spawned tree", async () => {
    const ctx = makeCtx();
    ctx.setPost(false);
    const m = new CoreManager(baseCfg, "C:/data", ctx.deps);
    await expect(m.ensureUp()).rejects.toThrow(/failed to become ready/);
    expect(m.state).toBe("idle");
    expect(ctx.killPids).toEqual([4242]);
    m.idle.dispose();
  });

  it("pauses for 5min after 3 consecutive failures, then resumes", async () => {
    const ctx = makeCtx();
    ctx.setPost(false);
    const m = new CoreManager(baseCfg, "C:/data", ctx.deps);
    for (let i = 0; i < 3; i++) {
      await expect(m.ensureUp()).rejects.toThrow(/failed to become ready/);
    }
    await expect(m.ensureUp()).rejects.toThrow(/paused after repeated failures/);
    ctx.setPost(true);
    await expect(m.ensureUp()).rejects.toThrow(/paused after repeated failures/);
    ctx.setNow(1_300_001);
    await m.ensureUp();
    expect(m.state).toBe("running");
    m.idle.dispose();
  });

  it("restarts after unexpected crash", async () => {
    const ctx = makeCtx();
    const m = new CoreManager(baseCfg, "C:/data", ctx.deps);
    await m.ensureUp();
    expect(ctx.spawnCalls).toBe(1);
    ctx.emitExit(0, null);
    expect(m.state).toBe("idle");
    await m.ensureUp();
    expect(ctx.spawnCalls).toBe(2);
    expect(m.state).toBe("running");
    m.idle.dispose();
  });

  it("stop kills the tree and returns to idle", async () => {
    const ctx = makeCtx();
    const m = new CoreManager(baseCfg, "C:/data", ctx.deps);
    await m.ensureUp();
    await m.stop();
    expect(m.state).toBe("idle");
    expect(ctx.killPids).toEqual([4242]);
    m.idle.dispose();
  });

  it("idle timer stops the core after requests end", async () => {
    const ctx = makeCtx();
    const m = new CoreManager({ ...baseCfg, idleMs: 50 }, "C:/data", ctx.deps);
    m.onRequestStart();
    await m.ensureUp();
    m.onRequestEnd();
    expect(ctx.killPids).toHaveLength(0);
    await sleep(150);
    expect(m.state).toBe("idle");
    expect(ctx.killPids).toEqual([4242]);
    m.idle.dispose();
  });
});
