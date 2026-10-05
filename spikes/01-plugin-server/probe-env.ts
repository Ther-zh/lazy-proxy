// Probe: does Bun.fetch honor HTTPS_PROXY env var (set by caller)?
try {
  const res = await fetch("https://example.com/");
  const text = await res.text();
  console.log(`ENV: status=${res.status} bytes=${text.length}`);
} catch (e) {
  console.log(`ENV: FAIL ${String(e).slice(0, 160)}`);
}
await new Promise((r) => setTimeout(r, 800));
process.exit(0);
