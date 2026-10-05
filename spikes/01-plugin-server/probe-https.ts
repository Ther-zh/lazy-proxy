// Probe: does Bun.fetch honor the `proxy` option for https (CONNECT)?
try {
  const res = await fetch("https://example.com/", { proxy: "http://127.0.0.1:17989" });
  const text = await res.text();
  console.log(`OPTION: status=${res.status} bytes=${text.length}`);
} catch (e) {
  console.log(`OPTION: FAIL ${String(e).slice(0, 160)}`);
}
await new Promise((r) => setTimeout(r, 800));
process.exit(0);
