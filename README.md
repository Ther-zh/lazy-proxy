# lazy-proxy

On-demand proxy runner for AI coding agents. Only starts your proxy core (mihomo/Clash) while an LLM request is actually in flight, and shuts it down after idle — so no VPN client needs to stay resident, and no other app is affected.

This repository currently ships:
- **opencode plugin** — a local shim (`127.0.0.1:17891`) that lazily starts/stops the core and forwards provider traffic.
- **standalone engine scripts** — `scripts/start-core.mjs` / `stop-core.mjs` (the same engine the plugin uses, usable directly).

Uses [mihomo](https://github.com/MetaCubeX/mihomo) (Clash.Meta family) as the proxy core. MIT license; mihomo binary is **not** bundled — it is downloaded on first run (with a Windows PowerShell download fallback if GitHub is unreachable).

> **Status**: MVP complete. Validated end-to-end with real airport subscriptions and both OpenAI API-key and Chat-OAuth paths.

---

## How it works

```
opencode ──(HTTP)──> plugin shim 127.0.0.1:17891 ──> mihomo core 127.0.0.1:17890 ──> airport node ──> upstream API
```

- **Trigger**: the first request reaching the shim starts the core (auto-download if needed, generate a minimal `config.yaml` from your subscription).
- **Idle**: after `idleMs` with no active connection, the core process is killed.
- **Safety**: listens only on `127.0.0.1`; never touches system proxy / TUN / firewall.
- **External core**: if a core is already listening on `corePort`, it is reused and never killed.

---

## Install

### opencode plugin

1. Build and install the plugin:

   ```bash
   bun install
   bun run build              # produces dist/plugin.js
   mkdir -p ~/.config/opencode/plugins
   cp dist/plugin.js ~/.config/opencode/plugins/lazy-proxy.js
   # Windows PowerShell: New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins"
   #                      Copy-Item dist/plugin.js "$env:USERPROFILE\.config\opencode\plugins\lazy-proxy.js"
   ```

2. Configure your config file (see below). The plugin reads it at startup.

### Standalone engine (without the plugin)

```bash
# start the core (reads the same config file)
bun scripts/start-core.mjs     # prints CORE_READY pid=... port=...
# then route your app through http://127.0.0.1:<corePort>
bun scripts/stop-core.mjs      # stops the core recorded in core.pid
```

Set `LAZYPROXY_CONFIG_DIR=/path/to/config-dir` to override the config location.

---

## Configuration

Config file: **`~/.config/lazyproxy/config.json`** (or `$env:LAZYPROXY_CONFIG_DIR/config.json`). Written automatically on first run with defaults; fill in at least `subscriptionUrl`.

```jsonc
{
  "subscriptionUrl": "https://your.airport.example/api/v1/client/subscribe?token=...",
  "subscriptionFile": "",        // optional: local Clash/mihomo YAML file; wins over subscriptionUrl
  "excludeNodes": "hk|tw",      // optional: regex of node names to EXCLUDE from the auto group
  "pinNode": "US-01",   // optional: exact node name to always use (highest priority)
  "shimPort": 17891,             // plugin shim listen port
  "corePort": 17890,             // mihomo mixed-port
  "idleMs": 180000,              // idle shutdown, ms
  "mihomoVersion": "v1.19.32",   // core binary version to auto-download
  "upstream": "https://api.openai.com",  // default upstream for the shim
  "logLevel": "info"
}
```

Notes:
- `subscriptionUrl` must be a **Clash/mihomo format** subscribe link (returns YAML with a `proxies` list).
- **Never commit this file / never share the token.** The plugin redacts tokens in logs.
- `excludeNodes` / `pinNode` matter for region-sensitive targets (e.g., OpenAI blocks HK/TW egress; pin a US/JP node or exclude unsupported regions).
- If the subscription endpoint is unreachable, save its YAML locally and set `subscriptionFile` instead.

---

## Pointing opencode at it

### A) API-key path (recommended, uses the shim)

```jsonc
// ~/.config/opencode/opencode.json
{
  "provider": {
    "openai": {
      "options": {
        "baseURL": "http://127.0.0.1:17891",
        "apiKey": "sk-..."          // your OpenAI platform API key
      },
      "models": { "gpt-4o-mini": { "name": "-4o Mini" } }
    }
  }
}
```

The shim lazily starts the core on the first request, tunnels via your subscription, and reaches `upstream` (`api.openai.com` by default).

### B) Chat OAuth path (Chat Plus/Pro account)

The Chat-OAuth flow talks to **chatgpt.com** (not `api.openai.com`), so:

1. Keep `provider.openai.options.baseURL` **unset** (default).
2. Run opencode with a proxy env pointing at the tunnel (e.g. `HTTPS_PROXY=http://127.0.0.1:<corePort>`, plus `NO_PROXY=localhost,127.0.0.1`), and keep the core running (`bun scripts/start-core.mjs`).
3. Authenticate once via `/connect` → OpenAI → Chat Plus/Pro (browser).
4. Use a model supported by Codex-with-Chat (e.g. `gpt-5.6-luna`); generic IDs like `gpt-4o-mini` are rejected.

---

## Development

```bash
bun test              # vitest suite
bun run typecheck     # tsc --noEmit
bun run build         # bundle the plugin -> dist/plugin.js
```

## Known caveats

- The core binary downloads from GitHub; on networks where GitHub is unreachable, the download falls back to a Windows `Invoke-WebRequest` call. You can also pre-place the binary at `~/.config/lazyproxy/data/bin/mihomo-<version>.exe` to skip downloading.
- Node selection: a minimal `MATCH,PROXY` config with a url-test group picks the lowest-latency node. Use `excludeNodes`/`pinNode` for region-sensitive upstreams.
- Request bodies are buffered in memory (fine for chat JSON).