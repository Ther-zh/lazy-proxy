import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import type { LazyProxyConfig } from "../config/schema";
import { IdleTracker } from "./idle";
import { ensureBinary } from "./download";
import { ensureConfig } from "./generate-config";

export type CoreState = "idle" | "starting" | "running" | "stopping";

export interface SpawnedProcess {
  pid: number;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(): void;
}

export interface CoreManagerDeps {
  ensureBinary: (dataDir: string, cfg: LazyProxyConfig) => Promise<string>;
  ensureConfig: (dataDir: string, cfg: LazyProxyConfig) => Promise<string>;
  spawn: (binary: string, dataDir: string) => SpawnedProcess;
  isPortReady: (port: number, timeoutMs: number) => Promise<boolean>;
  killTree: (pid: number) => void;
  now: () => number;
}

const FAIL_PAUSE_MS = 300_000;
const START_TIMEOUT_MS = 15_000;

function spawnMihomo(binary: string, dataDir: string): SpawnedProcess {
  const configPath = join(dataDir, "config.yaml");
  const child = spawn(binary, ["-f", configPath, "-d", dataDir], { stdio: "ignore", windowsHide: true });
  return {
    pid: child.pid ?? 0,
    onExit: (l) => child.once("exit", l),
    kill: () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

function killTree(pid: number): void {
  if (!pid) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

/** 轮询 TCP 端口直到就绪 */
export async function tcpPortReady(port: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ok = await tryConnect(port);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function tryConnect(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

export function defaultCoreDeps(): CoreManagerDeps {
  return {
    ensureBinary,
    ensureConfig,
    spawn: spawnMihomo,
    isPortReady: tcpPortReady,
    killTree,
    now: () => Date.now(),
  };
}

/**
 * mihomo 核心生命周期：首请求 ensureUp 拉起、空闲归零 stop 杀掉。
 * - 外部核心（端口已监听）→ 不接管、永不杀；
 * - 连续 3 次启动失败 → 暂停 5 分钟。
 */
export class CoreManager {
  state: CoreState = "idle";
  external = false;
  readonly idle: IdleTracker;

  private child: SpawnedProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failures = 0;
  private pauseUntil = 0;

  constructor(
    private readonly cfg: LazyProxyConfig,
    private readonly dataDir: string,
    private readonly deps: CoreManagerDeps,
  ) {
    this.idle = new IdleTracker(cfg.idleMs, () => void this.stop());
  }

  /** shim 收到请求时调用 */
  onRequestStart(): void {
    this.idle.increment();
  }

  /** shim 请求结束时调用 */
  onRequestEnd(): void {
    this.idle.decrement();
  }

  /** 确保核心可用；失败抛错（shim 转 502） */
  ensureUp(): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (this.state === "starting" && this.startPromise) return this.startPromise;
    return this.enqueue("start");
  }

  stop(): Promise<void> {
    if (this.state === "idle" || this.external) return Promise.resolve();
    return this.enqueue("stop");
  }

  private enqueue(op: "start" | "stop"): Promise<void> {
    const run = this.chain.then(() => (op === "start" ? this.doStart() : this.doStop()));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doStart(): Promise<void> {
    if (this.state === "running") return;
    if (this.pauseUntil > this.deps.now()) {
      throw new Error(`core paused after repeated failures (resume ${new Date(this.pauseUntil).toISOString()})`);
    }
    this.state = "starting";
    try {
      if (await this.deps.isPortReady(this.cfg.corePort, 400)) {
        this.external = true;
        this.state = "running";
        return;
      }
      const binary = await this.deps.ensureBinary(this.dataDir, this.cfg);
      await this.deps.ensureConfig(this.dataDir, this.cfg);
      const child = this.deps.spawn(binary, this.dataDir);
      this.child = child;
      child.onExit(() => {
        if (this.state === "running") {
          this.state = "idle";
          this.child = null;
        }
      });
      const ok = await this.deps.isPortReady(this.cfg.corePort, START_TIMEOUT_MS);
      if (!ok) {
        this.failures++;
        this.killChild();
        this.state = "idle";
        if (this.failures >= 3) {
          this.pauseUntil = this.deps.now() + FAIL_PAUSE_MS;
          this.failures = 0;
        }
        throw new Error("core failed to become ready within timeout");
      }
      this.failures = 0;
      this.state = "running";
    } catch (e) {
      this.state = "idle";
      throw e;
    }
  }

  private async doStop(): Promise<void> {
    if (this.state === "idle" || this.external) return;
    this.state = "stopping";
    this.killChild();
    this.state = "idle";
  }

  private killChild(): void {
    if (this.child) {
      this.deps.killTree(this.child.pid);
      this.child = null;
    }
  }
}
