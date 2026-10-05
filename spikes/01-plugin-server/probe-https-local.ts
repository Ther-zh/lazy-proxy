// Probe: Bun.fetch with proxy option against the LOCAL TLS upstream (17991).
// Proves the full https→CONNECT→TLS→upstream path offline (self-signed cert,
// so run with NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment).
try {
  const res = await fetch("https://127.0.0.1:17991/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer spike-key-123", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    proxy: "http://127.0.0.1:17989",
  });
  const text = await res.text();
  console.log(`HTTPS-PROXY-LOCAL: status=${res.status} body=${text.slice(0, 140)}`);
  if (text.includes("FAKE-TLS-OK") && text.includes("spike-key-123")) { console.log("HTTPS-PROXY-LOCAL: PASS"); process.exit(0); }
  process.exit(1);
} catch (e) {
  console.log(`HTTPS-PROXY-LOCAL: FAIL ${String(e).slice(0, 160)}`);
  process.exit(1);
}
