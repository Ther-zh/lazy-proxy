// T0 Spike (A): prove a plugin can run a long-lived Bun.serve and that opencode
// routes provider traffic to it (baseURL -> this server). Handles both the
// chat/completions and responses API shapes.
const server = Bun.serve({
  port: 17999,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini", object: "model", owned_by: "fake" }] }), { headers: { "content-type": "application/json" } });
    }
    const body = await req.text().catch(() => "");
    console.log(`PROBE-PLUGIN HIT ${req.method} ${url.pathname} bodyLen=${body.length}`);
    if (url.pathname === "/v1/responses") {
      const resp = {
        id: "resp_probe", object: "response", created_at: 0, status: "completed", model: "gpt-4o-mini",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "PLUGIN-SERVER-OK", annotations: [] }] }],
      };
      return new Response(JSON.stringify(resp), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "probe-cmpl", object: "chat.completion", created: 0, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: "PLUGIN-SERVER-OK" }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } });
  },
});
console.log(`PROBE-PLUGIN SERVER READY port=17999`);

export const ProbePlugin = async () => {
  console.log("PROBE-PLUGIN INITIALIZED");
  return {};
};
