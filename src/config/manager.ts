import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, type LazyProxyConfig } from "./schema";

export class ConfigError extends Error {}

export function configFilePath(dir: string): string {
  return join(dir, "config.json");
}

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;

function isLogLevel(v: unknown): v is LazyProxyConfig["logLevel"] {
  return typeof v === "string" && (["debug", "info", "warn", "error"] as string[]).includes(v);
}

export function validateConfig(raw: unknown): LazyProxyConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("config must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  const subscriptionUrl = typeof r.subscriptionUrl === "string" ? r.subscriptionUrl.trim() : "";
  if (!subscriptionUrl) {
    throw new ConfigError(
      "subscriptionUrl is required: paste your airport Clash/mihomo format subscribe URL",
    );
  }
  return {
    subscriptionUrl,
    shimPort: num(r.shimPort, DEFAULTS.shimPort),
    corePort: num(r.corePort, DEFAULTS.corePort),
    idleMs: num(r.idleMs, DEFAULTS.idleMs),
    corePath: typeof r.corePath === "string" && r.corePath.trim() ? r.corePath.trim() : undefined,
    downloadBaseUrl:
      typeof r.downloadBaseUrl === "string" && r.downloadBaseUrl.trim()
        ? r.downloadBaseUrl.trim()
        : undefined,
    mihomoVersion:
      typeof r.mihomoVersion === "string" && r.mihomoVersion.trim()
        ? r.mihomoVersion.trim()
        : DEFAULTS.mihomoVersion,
    upstream: typeof r.upstream === "string" && r.upstream.trim() ? r.upstream.trim() : DEFAULTS.upstream,
    logLevel: isLogLevel(r.logLevel) ? r.logLevel : DEFAULTS.logLevel,
  };
}

/** 读取目录下的 config.json；缺失时写出默认文件并返回（subscriptionUrl 为空，等待用户填写） */
export function loadConfig(dir: string): LazyProxyConfig {
  const p = configFilePath(dir);
  if (!existsSync(p)) {
    const def: LazyProxyConfig = { ...DEFAULTS, subscriptionUrl: "" };
    writeFileSync(p, JSON.stringify(def, null, 2), "utf8");
    return def;
  }
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    throw new ConfigError(`read config.json failed: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("config.json is not valid JSON");
  }
  return validateConfig(parsed);
}
