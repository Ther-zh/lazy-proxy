// 引擎脚本：按 core.pid 杀掉 mihomo 进程树。
// 用法：LAZYPROXY_CONFIG_DIR=<dir> bun scripts/stop-core.mjs
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const cfgDir = process.env.LAZYPROXY_CONFIG_DIR ?? join(homedir(), ".config", "lazyproxy");
const pidFile = join(cfgDir, "data", "core.pid");
if (!existsSync(pidFile)) {
  console.log("NO_PID");
  process.exit(0);
}
const pid = Number(readFileSync(pidFile, "utf8").trim());
if (pid) {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  console.log(`CORE_STOPPED pid=${pid}`);
}
