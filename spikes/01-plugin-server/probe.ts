// T0 Spike (B): does Bun.fetch honor the `proxy` option (http path)?
const res = await fetch("http://127.0.0.1:17990/v1/chat/completions", {
  method: "POST",
  headers: { authorization: "Bearer spike-key-123", "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
  proxy: "http://127.0.0.1:17989",
});
const json = await res.json();
const content = json?.choices?.[0]?.message?.content ?? "(no content)";
if (content.includes("viaProxy=yes") && content.includes("spike-key-123")) {
  console.log(`PROXY-OK: ${content}`);
  process.exit(0);
} else {
  console.error(`PROXY-FAIL: ${content}`);
  process.exit(1);
}
