// Probe: Bun.fetch https THROUGH the (fixed) TCP proxy to real external hosts.
// Success = status received AND the proxy log shows the CONNECT.
for (const url of ["https://example.com/", "https://www.baidu.com/"]) {
  try {
    const res = await fetch(url, { proxy: "http://127.0.0.1:17989" });
    const t = await res.text();
    console.log(`${url}: status=${res.status} bytes=${t.length}`);
  } catch (e) {
    console.log(`${url}: FAIL ${String(e).slice(0, 120)}`);
  }
  await Bun.sleep(500);
}
process.exit(0);
