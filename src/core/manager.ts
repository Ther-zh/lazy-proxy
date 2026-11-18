import { spawn, spawnSync } from "node:child_process";
import { closeSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { LazyProxyConfig } from "../config/schema";
import { IdleTracker } from "./idle";
import { ensureBinary } from "./download";
import { ensureConfig } from "./generate-config";
import { makeConsoleLogger, openCoreLog } from "./log";

export type CoreState = "idle" | "starting" | "running" | "stopping";
export type CoreLogger = (level: "debug" | "info" | "warn" | "error", message: string) => void;

export interface SpawnedProcess {
  pid: number;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(): void;
}

export interface CoreManagerDeps {
  ensureBinary: (dataDir: string, cfg: LazyProxyConfig) => Promise<string>;
  ensureConfig: (
    dataDir: string,
    cfg: LazyProxyConfig,
    opts?: { log?: CoreLogger },
  ) => Promise<string>;
  spawn: (binary: string, dataDir: string) => SpawnedProcess;
  isPortReady: (port: number, timeoutMs: number) => Promise<boolean>;
  killTree: (pid: number) => void;
  now: () => number;
  log?: CoreLogger;
}

const FAIL_PAUSE_MS = 300_000;
const START_TIMEOUT_MS = 15_000;
/** 外部核心存活探测的最小间隔 */
const EXTERNAL_PROBE_INTERVAL_MS = 1_000;
const EXTERNAL_PROBE_TIMEOUT_MS = 300;
/** 停核后等待端口释放的上限 */
const STOP_PORT_WAIT_MS = 2_000;
const STOP_PORT_POLL_MS = 100;

function spawnMihomo(binary: string, dataDir: string): SpawnedProcess {
  const configPath = join(dataDir, "config.yaml");
  // 核心日志落盘（超过 2MB 轮转），排障时不再黑盒
  const logFd = openCoreLog(dataDir);
  const child = spawn(binary, ["-f", configPath, "-d", dataDir], {
    stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
    windowsHide: true,
  });
  if (logFd !== null) {
    try {
      closeSync(logFd);
    } catch {
      /* 父进程副本关闭失败不影响子进程 */
    }
  }
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
    ensureConfig: (dataDir, cfg, opts) => ensureConfig(dataDir, cfg, fetch, opts),
    spawn: spawnMihomo,
    isPortReady: tcpPortReady,
    killTree,
    now: () => Date.now(),
    log: makeConsoleLogger(),
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
  private externalProbe: Promise<void> | null = null;
  private lastExternalProbe = 0;
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
    if (this.state === "running") {
      if (this.external) return this.ensureExternalAlive();
      return Promise.resolve();
    }
    return this.beginStart();
  }

  stop(): Promise<void> {
    if (this.state === "idle" || this.external) return Promise.resolve();
    return this.enqueue("stop");
  }

  /** 冷启动去重：并发的 ensureUp 共享同一个启动 Promise */
  private beginStart(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const p = this.enqueue("start").finally(() => {
      if (this.startPromise === p) this.startPromise = null;
    });
    this.startPromise = p;
    return p;
  }

  /** 外部核心：定期探测存活；消失后自动重启（不再永久停在 running） */
  private ensureExternalAlive(): Promise<void> {
    if (this.externalProbe) return this.externalProbe;
    const now = this.deps.now();
    if (now - this.lastExternalProbe < EXTERNAL_PROBE_INTERVAL_MS) return Promise.resolve();
    this.lastExternalProbe = now;
    const p = (async () => {
      if (await this.deps.isPortReady(this.cfg.corePort, EXTERNAL_PROBE_TIMEOUT_MS)) return;
      this.log("warn", `external core on 127.0.0.1:${this.cfg.corePort} disappeared; restarting`);
      this.external = false;
      this.state = "idle";
      await this.beginStart();
    })().finally(() => {
      if (this.externalProbe === p) this.externalProbe = null;
    });
    this.externalProbe = p;
    return p;
  }

  private enqueue(op: "start" | "stop"): Promise<void> {
    const run = this.chain.then(() => (op === "start" ? this.doStart() : this.doStop()));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    try {
      this.deps.log?.(level, message);
    } catch {
      /* 日志失败不影响主流程 */
    }
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
        this.lastExternalProbe = this.deps.now();
        this.state = "running";
        this.log("debug", `using external core on 127.0.0.1:${this.cfg.corePort}`);
        return;
      }
      this.log("info", `starting core on 127.0.0.1:${this.cfg.corePort}`);
      const binary = await this.deps.ensureBinary(this.dataDir, this.cfg);
      await this.deps.ensureConfig(this.dataDir, this.cfg, { log: this.deps.log });
      const child = this.deps.spawn(binary, this.dataDir);
      this.external = false;
      this.child = child;
      child.onExit((code, signal) => {
        this.log("warn", `core exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
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
        this.log("error", "core failed to become ready within timeout");
        throw new Error("core failed to become ready within timeout");
      }
      this.failures = 0;
      this.state = "running";
      this.log("info", `core ready (pid=${child.pid})`);
    } catch (e) {
      this.state = "idle";
      this.log("error", `core start failed: ${(e as Error).message}`);
      throw e;
    }
  }

  private async doStop(): Promise<void> {
    if (this.state === "idle" || this.external) return;
    this.state = "stopping";
    this.killChild();
    // Windows 上 taskkill 返回后进程/端口可能短暂残留；等端口真正释放再回到 idle，
    // 避免下一个请求把“正在退出的核心”误判为 external。
    await this.waitPortFree(this.cfg.corePort, STOP_PORT_WAIT_MS);
    this.state = "idle";
    this.log("info", "core stopped");
  }

  private async waitPortFree(port: number, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    for (;;) {
      if (!(await this.deps.isPortReady(port, 150))) return;
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, STOP_PORT_POLL_MS));
    }
  }

  private killChild(): void {
    if (this.child) {
      this.deps.killTree(this.child.pid);
      this.child = null;
    }
  }
}
