export interface LazyProxyConfig {
  /** 机场 Clash/mihomo 格式订阅 URL（含 token） */
  subscriptionUrl: string;
  /** opencode 插件 shim 监听端口 */
  shimPort: number;
  /** mihomo mixed-port */
  corePort: number;
  /** 空闲关闭阈值（毫秒） */
  idleMs: number;
  /** 手动指定 mihomo 二进制路径（覆盖自动下载） */
  corePath?: string;
  /** GitHub 镜像下载地址覆盖（如 ghproxy 前缀） */
  downloadBaseUrl?: string;
  /** mihomo 版本（release tag，如 v1.19.32） */
  mihomoVersion: string;
  /** 上游 OpenAI-compatible 基地址 */
  upstream: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export const DEFAULTS = {
  shimPort: 17891,
  corePort: 17890,
  idleMs: 180_000,
  mihomoVersion: "v1.19.32",
  upstream: "https://api.openai.com",
  logLevel: "info",
} as const;

const LOG_LEVELS: readonly LazyProxyConfig["logLevel"][] = ["debug", "info", "warn", "error"];

/** 日志/报错时脱敏 URL（隐藏 token / userinfo） */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "***";
    }
    for (const key of ["token", "key", "secret", "password"]) {
      if (u.searchParams.has(key)) u.searchParams.set(key, "***");
    }
    return u.toString();
  } catch {
    return url.replace(/([?&](?:token|key|secret|password)=)[^&]+/gi, "$1***");
  }
}
