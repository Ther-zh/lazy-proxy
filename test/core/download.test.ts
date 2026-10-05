import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assetName,
  buildDownloadUrl,
  downloadToFile,
  ensureBinary,
  MIHOMO_RELEASES_BASE,
  sha256OfFile,
} from "../../src/core/download";
import { DEFAULTS } from "../../src/config/schema";

const cfg = {
  subscriptionUrl: "https://sub.example.com/api?token=x",
  shimPort: DEFAULTS.shimPort,
  corePort: DEFAULTS.corePort,
  idleMs: DEFAULTS.idleMs,
  mihomoVersion: "v1.19.32",
  upstream: DEFAULTS.upstream,
  logLevel: "info",
} as const;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lazyproxy-bin-"));
}

const FAKE_EXE = new Uint8Array([0x4d, 0x5a, 0x00, 0x01, 0x02, 0x03]); // "MZ..."

describe("assetName / buildDownloadUrl", () => {
  it("builds default asset name and url", () => {
    expect(assetName("v1.19.32")).toBe("mihomo-windows-amd64-v1.19.32.zip");
    expect(buildDownloadUrl(cfg)).toBe(
      `${MIHOMO_RELEASES_BASE}/v1.19.32/mihomo-windows-amd64-v1.19.32.zip`,
    );
  });
  it("honors mirror override", () => {
    expect(buildDownloadUrl({ ...cfg, downloadBaseUrl: "https://mirror.example" })).toBe(
      "https://mirror.example/v1.19.32/mihomo-windows-amd64-v1.19.32.zip",
    );
  });
});

describe("sha256OfFile", () => {
  it("matches known sha256 of 'abc'", () => {
    const dir = tempDir();
    const p = join(dir, "f.txt");
    writeFileSync(p, "abc", "utf8");
    expect(sha256OfFile(p)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("downloadToFile", () => {
  it("writes body on ok and throws on http error", async () => {
    const dir = tempDir();
    const ok = join(dir, "ok.bin");
    await downloadToFile("https://x", ok, (async () => new Response(FAKE_EXE, { status: 200 })) as never);
    expect(readFileSync(ok)).toEqual(Buffer.from(FAKE_EXE));
    await expect(
      downloadToFile("https://x", join(dir, "bad.bin"), (async () => new Response("err", { status: 404 })) as never),
    ).rejects.toThrow(/HTTP 404/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("ensureBinary", () => {
  it("returns cfg.corePath when set and exists", async () => {
    const dir = tempDir();
    const exe = join(dir, "my-mihomo.exe");
    writeFileSync(exe, FAKE_EXE);
    const got = await ensureBinary(join(dir, "data"), { ...cfg, corePath: exe }, {} as never);
    expect(got).toBe(exe);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when corePath set but missing", async () => {
    const dir = tempDir();
    await expect(
      ensureBinary(join(dir, "data"), { ...cfg, corePath: join(dir, "nope.exe") }, {} as never),
    ).rejects.toThrow(/corePath not found/);
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = (overrides: Partial<Parameters<typeof ensureBinary>[2]> = {}) =>
    ({
      fetcher: (async () => new Response(FAKE_EXE, { status: 200 })) as never,
      unzip: (zip: string, dest: string) => writeFileSync(join(dest, "mihomo.exe"), FAKE_EXE),
      sha256: sha256OfFile,
      ...overrides,
    }) as Parameters<typeof ensureBinary>[2];

  it("downloads, TOFU records, extracts, returns target; second call is idempotent", async () => {
    const dir = tempDir();
    const data = join(dir, "data");
    const p1 = await ensureBinary(data, cfg, deps());
    expect(p1).toBe(join(data, "bin", "mihomo-v1.19.32.exe"));
    const rec = join(data, "bin", "mihomo-v1.19.32.sha256");
    expect(readFileSync(rec, "utf8").trim()).toHaveLength(64);
    const p2 = await ensureBinary(data, cfg, deps());
    expect(p2).toBe(p1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects on TOFU checksum mismatch", async () => {
    const dir = tempDir();
    const data = join(dir, "data");
    const recDir = join(data, "bin");
    mkdirSync(recDir, { recursive: true });
    writeFileSync(join(recDir, "mihomo-v1.19.32.sha256"), "0".repeat(64), "utf8");
    await expect(ensureBinary(data, cfg, deps())).rejects.toThrow(/checksum mismatch/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when mihomo.exe missing in archive", async () => {
    const dir = tempDir();
    const data = join(dir, "data");
    await expect(
      ensureBinary(data, cfg, deps({ unzip: () => {} })),
    ).rejects.toThrow(/mihomo.exe not found/);
    rmSync(dir, { recursive: true, force: true });
  });
});
