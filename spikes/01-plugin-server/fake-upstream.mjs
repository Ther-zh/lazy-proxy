// Fake OpenAI-compatible upstream for spike/integration tests.
// Verifies it receives the Authorization header and marks proxy passthrough.
const server = Bun.serve({
  port: 17990,
  async fetch(req) {
    const auth = req.headers.get("authorization") || "(none)";
    const viaProxy = req.headers.get("x-via-proxy") || "(none)";
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini", object: "model", owned_by: "fake" }] }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "fake-cmpl", object: "chat.completion", created: 0, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: `FAKE-OK auth=${auth} viaProxy=${viaProxy}` }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } });
  },
});
console.log(`FAKE-UPSTREAM READY pid=${process.pid} port=17990`);
