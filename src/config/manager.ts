import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, DEFAULT_HEALTH_CHECK_URL, type LazyProxyConfig } from "./schema";

export class ConfigError extends Error {}

export function configFilePath(dir: string): string {
  return join(dir, "config.json");
}

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;

function isLogLevel(v: unknown): v is LazyProxyConfig["logLevel"] {
  return typeof v === "string" && (["debug", "info", "warn", "error"] as string[]).includes(v);
}

function parseProxyHosts(v: unknown): string[] {
  if (!Array.isArray(v)) return [...DEFAULTS.proxyHosts];
  const cleaned = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return cleaned.length > 0 ? [...new Set(cleaned)] : [...DEFAULTS.proxyHosts];
}

/** 节点名大小写/emoji 敏感：只 trim、按原顺序去重，不做小写化 */
function parseNodeNames(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const cleaned = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
  return cleaned.length > 0 ? [...new Set(cleaned)] : undefined;
}

function parseHealthCheckUrl(v: unknown): string {
  if (typeof v !== "string") return DEFAULT_HEALTH_CHECK_URL;
  const url = v.trim();
  return /^https?:\/\//i.test(url) ? url : DEFAULT_HEALTH_CHECK_URL;
}

function parseBool(v: unknown, def: boolean): boolean {
  return typeof v === "boolean" ? v : def;
}

function parseBoundedInt(v: unknown, def: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.round(v)));
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
    subscriptionFile:
      typeof r.subscriptionFile === "string" && r.subscriptionFile.trim()
        ? r.subscriptionFile.trim()
        : undefined,
    excludeNodes:
      typeof r.excludeNodes === "string" && r.excludeNodes.trim() ? r.excludeNodes.trim() : undefined,
    pinNode: typeof r.pinNode === "string" && r.pinNode.trim() ? r.pinNode.trim() : undefined,
    fallbackNodes: parseNodeNames(r.fallbackNodes),
    healthCheckUrl: parseHealthCheckUrl(r.healthCheckUrl),
    retryForever: parseBool(r.retryForever, DEFAULTS.retryForever),
    retryDelayMs: parseBoundedInt(r.retryDelayMs, DEFAULTS.retryDelayMs, 100, 60_000),
    retryMaxDelayMs: parseBoundedInt(r.retryMaxDelayMs, DEFAULTS.retryMaxDelayMs, 1_000, 300_000),
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
    proxyHosts: parseProxyHosts(r.proxyHosts),
    logLevel: isLogLevel(r.logLevel) ? r.logLevel : DEFAULTS.logLevel,
  };
}

/** 读取目录下的 config.json；缺失时写出默认文件并返回（subscriptionUrl 为空，等待用户填写） */
export function loadConfig(dir: string): LazyProxyConfig {
  const p = configFilePath(dir);
  if (!existsSync(p)) {
    const def: LazyProxyConfig = { ...DEFAULTS, subscriptionUrl: "", proxyHosts: [...DEFAULTS.proxyHosts] };
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
