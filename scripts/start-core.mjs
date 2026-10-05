// 引擎脚本：启动 mihomo 核心（下载 + 订阅配置 + 拉起），打印 CORE_READY 并保持存活。
// 用法：LAZYPROXY_CONFIG_DIR=<dir> bun scripts/start-core.mjs
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config/manager";
import { ensureBinary } from "../src/core/download";
import { ensureConfig } from "../src/core/generate-config";
import { tcpPortReady } from "../src/core/manager";

const cfgDir = process.env.LAZYPROXY_CONFIG_DIR ?? join(homedir(), ".config", "lazyproxy");
const cfg = loadConfig(cfgDir);
const dataDir = join(cfgDir, "data");
const binary = await ensureBinary(dataDir, cfg);
await ensureConfig(dataDir, cfg);
const child = spawn(binary, ["-d", dataDir], { stdio: "ignore", windowsHide: true });
const ok = await tcpPortReady(cfg.corePort, 20_000);
if (!ok) {
  console.error(`CORE_FAILED port=${cfg.corePort}`);
  try {
    child.kill();
  } catch {
    /* noop */
  }
  process.exit(1);
}
writeFileSync(join(dataDir, "core.pid"), String(child.pid), "utf8");
console.log(`CORE_READY pid=${child.pid} port=${cfg.corePort}`);
setInterval(() => {}, 1_000); // keep alive
