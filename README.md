# lazy-proxy

[English](README.md) | [简体中文](README.zh-CN.md)

**On-demand proxy for AI coding agents.** Routes *only* your LLM provider's traffic (default: OpenAI/ChatGPT hosts) through your Clash/mihomo subscription. The core starts when a request needs it and stops after idle — no resident VPN client, no system-wide proxy, no effect on any other app or provider.

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Status: MVP complete](https://img.shields.io/badge/status-MVP%20complete-green)

This repository ships:

- **opencode plugin** — runs a loopback shim (`127.0.0.1:17891`) that lazily starts/stops the core, and patches `globalThis.fetch` in-process so only selected domains are tunneled. Works in both OpenCode CLI (Bun) and OpenCode Desktop (Electron/Node).
- **standalone engine scripts** — `scripts/start-core.mjs` / `scripts/stop-core.mjs` (the same engine the plugin uses, runnable on their own).

The core is [mihomo](https://github.com/MetaCubeX/mihomo) (Clash.Meta family). Binaries are **not** bundled — the Windows build is downloaded on first run (with a PowerShell fallback if GitHub is unreachable).

**Status: MVP complete** — validated end-to-end with real subscriptions on Windows, both OpenAI API-key and Chat-OAuth paths.

## Table of contents

- [Why lazy-proxy?](#why-lazy-proxy)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Pointing opencode at it](#pointing-opencode-at-it)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Development](#development)
- [Caveats](#caveats)
- [License & credits](#license--credits)

## Why lazy-proxy?

A Clash client in system-proxy or TUN mode keeps a core resident and sends everything through it. `lazy-proxy` does the opposite:

| | System proxy (Clash) | TUN mode | lazy-proxy |
|---|---|---|---|
| Traffic scope | every app that honors the OS/env proxy | all traffic, always | only `proxyHosts` (default OpenAI/ChatGPT) |
| Core lifecycle | resident | resident | on demand; killed after `idleMs` |
| Affects other apps | yes | yes | no |
| Affects other providers/models | yes (unless bypassed) | yes | no |
| Works with OpenCode Desktop (Electron) | only if the app honors proxy env — it doesn't | yes | yes (in-process fetch patch) |

## How it works

```
 proxyHosts requests ─▶ shim 127.0.0.1:17891 ─▶ mihomo 127.0.0.1:17890 ─▶ subscription node ─▶ upstream
 everything else ─────────────────────────────────────────────────────────────────────────────▶ direct
                       (core starts on demand; killed after idleMs)
```

- **Selective** — only hosts in `proxyHosts` (default `chatgpt.com`, `openai.com`; suffix match) are tunneled through the core. Every other host — other providers, other apps — goes direct, untouched.
- **Lazy** — the first proxied request starts the core: auto-download mihomo (if needed) → generate a minimal `config.yaml` from your subscription → spawn. After `idleMs` without active connections, the core is killed.
- **Two interception paths**
  - *API-key*: set `provider.openai.options.baseURL` to the shim; plain HTTP requests are forwarded through the core to `upstream` ([details](#a-api-key-path)).
  - *Chat OAuth / Desktop*: the plugin patches `globalThis.fetch` inside the opencode process; only `proxyHosts` requests are tunneled (CONNECT), everything else uses the original fetch ([details](#b-chat-oauth-path-chat-pluspro)).
- **External core** — if a core is already listening on `corePort`, it is reused and never killed.
- **Safety** — all listeners are loopback-only; no system proxy, TUN, firewall, or persisted environment variables are touched.

## Quick start

Requires [Bun](https://bun.sh) and a Clash/mihomo-format subscription (see [Requirements](#requirements)).

```bash
git clone https://github.com/Ther-zh/lazy-proxy && cd lazy-proxy
bun install
bun run build
mkdir -p ~/.config/opencode/plugins
cp dist/plugin.js ~/.config/opencode/plugins/lazy-proxy.js
```

Windows PowerShell equivalent for the last two lines:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins" | Out-Null
Copy-Item dist\plugin.js "$env:USERPROFILE\.config\opencode\plugins\lazy-proxy.js" -Force
```

Start opencode once — `~/.config/lazyproxy/config.json` is auto-created. Put your `subscriptionUrl` into it, restart opencode, then make one OpenAI/ChatGPT request. The first request starts the core; after `idleMs` of inactivity it goes away.

## Requirements

- **[Bun](https://bun.sh)** (developed on 1.3) — build, tests, and the engine scripts. Node.js ≥ 20 is used for the build script.
- A **Clash/mihomo-format subscription** — a URL returning YAML with a `proxies:` list (the typical airport "Clash" subscription).
- **Windows** is the validated platform. The shim and core manager are cross-platform (`node:http` / `node:net`); on macOS/Linux, provide your own mihomo binary via `corePath` (auto-download and `stop-core.mjs` currently target Windows).
- Network access to GitHub for the first core download — or pre-place the binary and set `corePath`, or set `downloadBaseUrl` to a mirror.

## Install

### Plugin (recommended)

1. Build and copy `dist/plugin.js` into opencode's plugin directory (see [Quick start](#quick-start)). opencode auto-loads every file in `~/.config/opencode/plugins/`.
2. Fill in `~/.config/lazyproxy/config.json` (auto-created on first run):

   ```jsonc
   {
     "subscriptionUrl": "https://your-airport.example/api/v1/client/subscribe?token=..."
   }
   ```

3. Restart opencode and check its log for:

   ```
   [lazy-proxy] shim on 127.0.0.1:17891; OpenAI traffic goes through the lazy core ...
   ```

   A `no subscription configured yet` warning means step 2 was missed.

### Standalone engine (without the plugin)

```bash
bun scripts/start-core.mjs   # prints CORE_READY pid=... port=17890, keeps running
# point your app at http://127.0.0.1:17890 (HTTP/HTTPS proxy)
bun scripts/stop-core.mjs    # CORE_STOPPED pid=...
```

Set `LAZYPROXY_CONFIG_DIR` to use a different config directory. Unlike the plugin, the script keeps the core alive until you stop it.

### Uninstall

1. Delete `~/.config/opencode/plugins/lazy-proxy.js` and restart opencode.
2. Stop a lingering core: `bun scripts/stop-core.mjs` (kills the PID recorded in `~/.config/lazyproxy/data/core.pid`).
3. Optionally delete `~/.config/lazyproxy/` (config, generated `config.yaml`, downloaded binary).

## Configuration

Config file: `~/.config/lazyproxy/config.json` (override the directory with `LAZYPROXY_CONFIG_DIR`). Auto-created with defaults on first run; only `subscriptionUrl` is required.

| Key | Default | Description |
|-----|---------|-------------|
| `subscriptionUrl` | — (required) | Clash/mihomo-format subscription URL. Contains your token — **never commit or share this file**. |
| `subscriptionFile` | — | Local subscription YAML; when set it wins over `subscriptionUrl` (useful when the endpoint is unreachable). |
| `proxyHosts` | `["chatgpt.com","openai.com"]` | Hosts routed through the core (suffix match: `openai.com` also covers `auth.openai.com`). Everything else goes direct. The shim `upstream` host is always included. |
| `excludeNodes` | — | Regex of node names to exclude from the auto group (e.g. `hk|tw` — OpenAI blocks some regions). |
| `pinNode` | — | Exact node name to pin (highest priority, wins over the auto group). |
| `shimPort` | `17891` | Shim listen port (loopback). |
| `corePort` | `17890` | mihomo mixed-port (loopback). |
| `idleMs` | `180000` | Kill the core after this much idle time. |
| `mihomoVersion` | `v1.19.32` | mihomo release tag to download. |
| `corePath` | — | Use an existing mihomo binary; skips auto-download. |
| `downloadBaseUrl` | — | Override the download base URL (mirror / ghproxy-style prefix). |
| `upstream` | `https://api.openai.com` | Default upstream for requests forwarded by the shim (API-key path). |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error`. |

Notes:

- Token safety: URLs are redacted (`token`, `key`, `secret`, `password` → `***`) in logs and error messages.
- Downloads are checksum-recorded on first fetch (TOFU) in `data/bin/mihomo-<version>.sha256`.
- If the subscription endpoint is unreachable, save its YAML locally and set `subscriptionFile`.

## Pointing opencode at it

### A) API-key path

In `~/.config/opencode/opencode.json`:

```jsonc
{
  "provider": {
    "openai": {
      "options": {
        "baseURL": "http://127.0.0.1:17891",
        "apiKey": "sk-..."
      }
    }
  }
}
```

The shim forwards requests to `http://127.0.0.1:17891/...` through the core to `upstream` (`https://api.openai.com` by default), lazily starting the core on the first request.

### B) Chat OAuth path (Chat Plus/Pro)

The Chat-OAuth flow talks to `chatgpt.com` and `auth.openai.com` (not `api.openai.com`), so the baseURL trick does not apply:

1. Keep `provider.openai.options.baseURL` **unset** (default).
2. The plugin patches `globalThis.fetch` inside opencode: requests to `proxyHosts` hosts are tunneled through the shim (CONNECT); every other URL goes to the original fetch. This is required because OpenCode Desktop's provider calls use Node's built-in `fetch` (undici), which ignores `HTTPS_PROXY`. Proxy env is also injected in-process as a fallback for env-reading libraries.
3. Authenticate once: `/connect` → OpenAI → Chat Plus/Pro (browser).
4. Use a model available to Codex-with-Chat (e.g. `gpt-5.6-luna`); unrelated model IDs are rejected upstream.

> **Do not set a system- or user-level `HTTPS_PROXY`.** That hijacks every app on the machine — if the core is ever down, everything fails (an early setup did exactly that). `lazy-proxy` scopes everything to the opencode process.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Cannot connect ... ECONNREFUSED 127.0.0.1:17890` | Something is pointed directly at the **core** port while the core is not running (e.g. a leftover user-level `HTTPS_PROXY=http://127.0.0.1:17890`). Apps should not use the core port directly — use the shim via `baseURL`, or let the plugin handle it. Remove stale proxy env vars (Windows: `reg query HKCU\Environment`; also check System Properties → Environment Variables) and restart the app. |
| `failed to load plugin` in opencode's log | The plugin file crashed while loading. Make sure the latest `dist/plugin.js` is installed. The plugin is designed never to throw on load; if it still happens, capture the log line and report it. |
| No `[lazy-proxy] shim on ...` line after restart | `subscriptionUrl` is still empty — fill `config.json` and restart opencode. |
| No listener on `17891` while opencode runs | Plugin not loaded or crashed (see above). |
| `403` from OpenAI | Egress region blocked (e.g. HK/TW). Pin a US/JP node: `pinNode`, or `excludeNodes` the blocked regions. |
| Core won't start | Run `bun scripts/start-core.mjs` in a terminal to see errors; run mihomo manually (`data/bin/mihomo-<version>.exe -d <config-dir>/data`) to see core logs. GitHub blocked → set `downloadBaseUrl`, or pre-place the binary and set `corePath`. |
| `EADDRINUSE` on the shim port | Another instance already holds `shimPort`; the plugin reuses it. Change `shimPort` if that is not what you want. |
| Verify what is listening | Windows: `netstat -ano | findstr 1789`; macOS/Linux: `lsof -iTCP:17890 -sTCP:LISTEN`. Expect `17891` while opencode runs; `17890` only while a request is in flight (or before the idle timer expires). |

## Security notes

- **Loopback only** — both the shim and the core bind `127.0.0.1`.
- **No MITM** — CONNECT tunnels are raw TCP; TLS terminates at the real server. The proxy sees only the hostname, never plaintext.
- **No persistent system changes** — no system proxy, TUN, firewall rules, or user/system-level environment variables. Proxy env is injected in-process and removed when the plugin is disposed.
- **Secret handling** — `config.json` holds your subscription token; it stays local, and logs redact token-like query parameters.

## Development

```
src/
  config/    schema + loader (validation, defaults, proxyHosts, redaction)
  core/      mihomo lifecycle: download (TOFU), config generation, idle watchdog, process manager
  plugin/    opencode entry: safe logging, process-scoped env injection, globalThis.fetch patch
  shim/      loopback HTTP + CONNECT shim (node:http) and transport helpers
scripts/     start-core.mjs / stop-core.mjs / build.mjs
test/        vitest unit + integration tests (fake mihomo core fixture)
```

```bash
bun install
bun test              # vitest suite
bun run typecheck     # tsc --noEmit
bun run build         # esbuild bundle -> dist/plugin.js
```

Notes:

- `src/plugin/index.ts` exports only `LazyProxyPlugin` — keep it that way (opencode auto-loads plugin exports).
- `dist/plugin.js` is a self-contained bundle; deploy it by copying to `~/.config/opencode/plugins/lazy-proxy.js`.

## Caveats

- **Windows first**: auto-download and `stop-core.mjs` target Windows; other platforms need `corePath`.
- Request bodies are buffered in memory (fine for chat-sized JSON).
- The first proxied request after idle pays the cold start (core spawn + initial node selection).
- One core per config directory; concurrent opencode processes share it (an external core is reused, not killed).

## License & credits

MIT — see [LICENSE](LICENSE). [mihomo](https://github.com/MetaCubeX/mihomo) is a separate project, downloaded at runtime, under its own license.
