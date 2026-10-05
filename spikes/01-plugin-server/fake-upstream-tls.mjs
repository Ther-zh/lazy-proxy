// TLS-enabled fake upstream (port 17991) using the generated self-signed cert.
import { readFileSync } from "node:fs";
const cert = readFileSync("D:/LearnMT/lazy-proxy/spikes/01-plugin-server/tls-cert.pem", "utf8");
const key = readFileSync("D:/LearnMT/lazy-proxy/spikes/01-plugin-server/tls-key.pem", "utf8");
const server = Bun.serve({
  port: 17991,
  tls: { cert, key },
  async fetch(req) {
    const auth = req.headers.get("authorization") || "(none)";
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini", object: "model", owned_by: "fake" }] }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "tls-cmpl", object: "chat.completion", created: 0, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: `FAKE-TLS-OK auth=${auth}` }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } });
  },
});
console.log(`FAKE-UPSTREAM-TLS READY pid=${process.pid} port=17991`);
