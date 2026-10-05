import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LazyProxyConfig } from "../config/schema";
import type { Fetcher } from "./generate-config";

export const MIHOMO_RELEASES_BASE = "https://github.com/MetaCubeX/mihomo/releases/download";

/** Windows amd64 资产名，如 mihomo-windows-amd64-v1.19.32.zip */
export function assetName(version: string): string {
  return `mihomo-windows-amd64-${version}.zip`;
}

export function buildDownloadUrl(cfg: Pick<LazyProxyConfig, "mihomoVersion" | "downloadBaseUrl">): string {
  const asset = assetName(cfg.mihomoVersion);
  if (cfg.downloadBaseUrl) {
    return `${cfg.downloadBaseUrl}/${cfg.mihomoVersion}/${asset}`;
  }
  return `${MIHOMO_RELEASES_BASE}/${cfg.mihomoVersion}/${asset}`;
}

export function sha256OfFile(p: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(p));
  return h.digest("hex");
}

export async function downloadToFile(url: string, dest: string, fetcher: Fetcher = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetcher(url, { headers: { "user-agent": "lazy-proxy/0.1" } });
  } catch (e) {
    throw new Error(`download failed: ${(e as Error).message} ${url}`);
  }
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${url}`);
  }
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Windows: PowerShell Expand-Archive 解压 zip */
export function unzipArchive(zipPath: string, destDir: string): void {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (r.status !== 0) {
    throw new Error(`unzip failed: ${(r.stderr ?? r.stdout ?? "").trim()}`);
  }
}

/** Windows 兜底下载：Bun fetch 连不上 GitHub CDN 时用 PowerShell 原生下载 */
export async function downloadViaPowershell(url: string, dest: string): Promise<void> {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile '${dest}'`],
    { encoding: "utf8", timeout: 180_000 },
  );
  if (r.status !== 0) {
    throw new Error(`powershell download failed: ${(r.stderr ?? r.stdout ?? "").trim()}`);
  }
}

export interface BinaryDeps {
  fetcher: Fetcher;
  unzip: (zip: string, dest: string) => void;
  sha256: (p: string) => string;
  /** 可选：fetch 失败后的原生下载兜底（测试不注入则直接抛错） */
  powerShellDownload?: (url: string, dest: string) => Promise<void>;
}

const defaultDeps: BinaryDeps = {
  fetcher: fetch,
  unzip: unzipArchive,
  sha256: sha256OfFile,
  powerShellDownload: downloadViaPowershell,
};

/**
 * 确保 mihomo 二进制可用：
 * - cfg.corePath 指定则校验并直接返回；
 * - 否则自动下载（pin 版本）、TOFU 校验、解压到 dataDir/bin。
 */
export async function ensureBinary(
  dataDir: string,
  cfg: LazyProxyConfig,
  deps: BinaryDeps = defaultDeps,
): Promise<string> {
  if (cfg.corePath) {
    if (!existsSync(cfg.corePath)) {
      throw new Error(`corePath not found: ${cfg.corePath}`);
    }
    return cfg.corePath;
  }
  const binDir = join(dataDir, "bin");
  const version = cfg.mihomoVersion;
  const target = join(binDir, `mihomo-${version}.exe`);
  if (existsSync(target)) return target;

  mkdirSync(binDir, { recursive: true });
  const url = buildDownloadUrl(cfg);
  const tmpZip = join(binDir, `${version}.zip`);
  try {
    await downloadToFile(url, tmpZip, deps.fetcher);
  } catch (e) {
    if (deps.powerShellDownload) {
      await deps.powerShellDownload(url, tmpZip);
    } else {
      throw e;
    }
  }

  const hash = deps.sha256(tmpZip);
  const rec = join(binDir, `mihomo-${version}.sha256`);
  if (existsSync(rec)) {
    const prev = readFileSync(rec, "utf8").trim();
    if (prev !== hash) {
      throw new Error(`mihomo checksum mismatch (TOFU): recorded ${prev}, got ${hash}`);
    }
  } else {
    writeFileSync(rec, `${hash}\n`, "utf8");
  }

  const tmpDir = join(binDir, `unzip-${version}`);
  mkdirSync(tmpDir, { recursive: true });
  deps.unzip(tmpZip, tmpDir);
  const extracted = join(tmpDir, "mihomo.exe");
  if (!existsSync(extracted)) {
    throw new Error("mihomo.exe not found in archive");
  }
  renameSync(extracted, target);
  rmSync(tmpZip, { force: true });
  rmSync(tmpDir, { recursive: true, force: true });
  return target;
}
