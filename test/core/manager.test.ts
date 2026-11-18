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
  setLinger: (ms: number) => void;
  setNow: (n: number) => void;
}

function makeCtx(): FakeCtx {
  let now = 1_000_000;
  let postReady = true;
  let listening = false;
  let lingerMs = 0;
  let checks = 0;
  const listeners = new Set<(code: number | null, sig: string | null) => void>();
  const child: SpawnedProcess = {
    pid: 4242,
    onExit: (l) => {
      listeners.add(l);
    },
    kill: () => {},
  };
  /** kill 之后端口是否残留一段时间（模拟 Windows 进程退出延迟） */
  const releasePort = () => {
    if (lingerMs <= 0) {
      listening = false;
    } else {
      setTimeout(() => {
        listening = false;
      }, lingerMs);
    }
  };
  const ctx: FakeCtx = {
    spawnCalls: 0,
    killPids: [],
    binaryCalls: 0,
    configCalls: 0,
    child,
    emitExit: (c, s) => {
      listening = false;
      for (const l of [...listeners]) l(c, s);
    },
    setExternal: (v) => {
      listening = v;
    },
    setPost: (v) => {
      postReady = v;
    },
    setLinger: (ms) => {
      lingerMs = ms;
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
        // 短探测（外部核探测/存活探测/停核等待）只看当前端口；启动等待模拟进程绑定端口
        if (timeoutMs <= 1000) return listening;
        if (!postReady) return false;
        listening = true;
        return true;
      },
      killTree: (pid) => {
        ctx.killPids.push(pid);
        releasePort();
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

  it("restarts when an external core disappears", async () => {
    const ctx = makeCtx();
    ctx.setExternal(true);
    const m = new CoreManager(baseCfg, "C:/data", ctx.deps);
    await m.ensureUp();
    expect(m.external).toBe(true);
    expect(ctx.spawnCalls).toBe(0);

    ctx.setExternal(false);
    ctx.setNow(1_002_000);
    await m.ensureUp();
    expect(m.state).toBe("running");
    expect(m.external).toBe(false);
    expect(ctx.spawnCalls).toBe(1);
    m.idle.dispose();
  });

  it("waits for the port to be released before reporting idle", async () => {
    const ctx = makeCtx();
    ctx.setLinger(300);
    const m = new CoreManager(baseCfg, "C:/data", ctx.deps);
    await m.ensureUp();

    const t0 = Date.now();
    await m.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);

    await m.ensureUp();
    expect(m.external).toBe(false);
    expect(ctx.spawnCalls).toBe(2);
    m.idle.dispose();
  });

  it("coalesces concurrent cold starts into a single spawn", async () => {
    const ctx = makeCtx();
    const m = new CoreManager(baseCfg, "C:/data", ctx.deps);
    await Promise.all([m.ensureUp(), m.ensureUp(), m.ensureUp()]);
    expect(ctx.spawnCalls).toBe(1);
    expect(ctx.configCalls).toBe(1);
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
