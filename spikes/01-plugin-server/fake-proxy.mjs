// Minimal HTTP forward proxy for spike. For absolute-form http requests it
// marks the passthrough with x-via-proxy so we can prove Bun.fetch({proxy}) works.
const server = Bun.serve({
  port: 17989,
  async fetch(req) {
    const target = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set("x-via-proxy", "yes");
    console.log(`FAKE-PROXY HIT ${req.method} ${target.href}`);
    return await fetch(target.href, { method: req.method, headers, body: req.body });
  },
});
console.log(`FAKE-PROXY READY pid=${process.pid} port=17989`);
