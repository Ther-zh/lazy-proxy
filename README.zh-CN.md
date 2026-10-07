# lazy-proxy

[English](README.md) | [简体中文](README.zh-CN.md)

**面向 AI 编程助手的按需代理。** 只把 LLM 提供商的流量（默认 OpenAI/ChatGPT 域名）经你的 Clash/mihomo 订阅转发；内核在请求到来时才启动、空闲后自动退出——没有常驻 VPN 客户端、没有系统级代理，也不影响任何其他应用或提供商。

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Status: MVP complete](https://img.shields.io/badge/status-MVP%20complete-green)

本仓库包含：

- **opencode 插件** —— 在本地回环地址运行一个 shim（`127.0.0.1:17891`），按需启停内核；并在进程内打补丁拦截 `globalThis.fetch`，只转发白名单域名。同时支持 OpenCode CLI（Bun）与 OpenCode Desktop（Electron/Node）。
- **独立引擎脚本** —— `scripts/start-core.mjs` / `scripts/stop-core.mjs`（插件用的同一套引擎，可单独使用）。

内核是 [mihomo](https://github.com/MetaCubeX/mihomo)（Clash.Meta 系）。二进制**不随仓库分发**——首次运行时下载 Windows 版本（GitHub 不可达时回退到 PowerShell 下载）。

**状态：MVP 完成** —— 已在 Windows 上用真实机场订阅完成端到端验证，覆盖 OpenAI API-key 与 Chat-OAuth 两条路径。

## 目录

- [为什么需要 lazy-proxy](#为什么需要-lazy-proxy)
- [工作原理](#工作原理)
- [快速开始](#快速开始)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [接入 opencode](#接入-opencode)
- [故障排查](#故障排查)
- [安全性](#安全性)
- [开发](#开发)
- [已知限制](#已知限制)
- [许可证与致谢](#许可证与致谢)

## 为什么需要 lazy-proxy

Clash 开系统代理或 TUN 模式时，内核常驻内存，**所有**流量都走代理。`lazy-proxy` 正好相反：

| | 系统代理（Clash） | TUN 模式 | lazy-proxy |
|---|---|---|---|
| 流量范围 | 所有遵循系统/环境代理的应用 | 全部流量，始终 | 仅 `proxyHosts`（默认 OpenAI/ChatGPT） |
| 内核生命周期 | 常驻 | 常驻 | 按需启动，空闲 `idleMs` 后退出 |
| 影响其他应用 | 是 | 是 | 否 |
| 影响其他提供商/模型 | 是（除非绕过） | 是 | 否 |
| 对 OpenCode Desktop（Electron）有效 | 仅在应用遵循代理 env 时——它不遵循 | 有效 | 有效（进程内 fetch 补丁） |

## 工作原理

```
 白名单请求 ──▶ shim 127.0.0.1:17891 ──▶ mihomo 127.0.0.1:17890 ──▶ 订阅节点 ──▶ 上游
 其余全部   ───────────────────────────────────────────────────────────────▶ 直连
              （内核按需启动；空闲 idleMs 后被杀掉）
```

- **选择性** —— 只有 `proxyHosts` 里的主机（默认 `chatgpt.com`、`openai.com`，后缀匹配）经内核转发。其他一切流量——其他提供商、其他应用——全部直连，不受影响。
- **惰性** —— 第一个被代理的请求触发内核启动：自动下载 mihomo（如需）→ 根据订阅生成最小 `config.yaml` → 拉起进程。`idleMs` 内无活跃连接则杀掉内核。
- **两条拦截路径**
  - *API-key*：把 `provider.openai.options.baseURL` 指向 shim，普通 HTTP 请求经内核转发到 `upstream`（[详见](#a-api-key-路径)）。
  - *Chat OAuth / Desktop*：插件在 opencode 进程内打 `globalThis.fetch` 补丁，只对 `proxyHosts` 请求走 CONNECT 隧道，其余 URL 走原始 fetch（[详见](#b-chat-oauth-路径chat-pluspro)）。
- **外部内核** —— 若 `corePort` 上已有内核在监听，直接复用且永不杀掉。
- **安全边界** —— 所有监听都在回环地址；不碰系统代理、TUN、防火墙，也不写持久化环境变量。

## 快速开始

需要 [Bun](https://bun.sh) 与一份 Clash/mihomo 格式的订阅（见[环境要求](#环境要求)）。

```bash
git clone https://github.com/Ther-zh/lazy-proxy && cd lazy-proxy
bun install
bun run build
mkdir -p ~/.config/opencode/plugins
cp dist/plugin.js ~/.config/opencode/plugins/lazy-proxy.js
```

Windows PowerShell 等价命令（后两行）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins" | Out-Null
Copy-Item dist\plugin.js "$env:USERPROFILE\.config\opencode\plugins\lazy-proxy.js" -Force
```

先启动一次 opencode——`~/.config/lazyproxy/config.json` 会自动生成。把 `subscriptionUrl` 填进去，重启 opencode，然后随便发一个 OpenAI/ChatGPT 请求。首个请求会启动内核；空闲 `idleMs` 后它自动退出。

## 环境要求

- **[Bun](https://bun.sh)**（开发用 1.3）——构建、测试与引擎脚本。构建脚本使用 Node.js ≥ 20。
- 一份 **Clash/mihomo 格式订阅** —— 返回带 `proxies:` 列表的 YAML（机场"Clash 订阅"一般即是）。
- **Windows 是已验证平台**。shim 与内核管理器是跨平台的（`node:http` / `node:net`）；macOS/Linux 用户请通过 `corePath` 自备 mihomo 二进制（自动下载与 `stop-core.mjs` 目前面向 Windows）。
- 首次下载内核需要访问 GitHub——或预放二进制并设置 `corePath`，或把 `downloadBaseUrl` 指向镜像。

## 安装

### 插件（推荐）

1. 构建并把 `dist/plugin.js` 复制到 opencode 插件目录（见[快速开始](#快速开始)）。opencode 会自动加载 `~/.config/opencode/plugins/` 下的每个文件。
2. 填写 `~/.config/lazyproxy/config.json`（首次运行自动生成）：

   ```jsonc
   {
     "subscriptionUrl": "https://your-airport.example/api/v1/client/subscribe?token=..."
   }
   ```

3. 重启 opencode，在日志里确认出现：

   ```
   [lazy-proxy] shim on 127.0.0.1:17891; OpenAI traffic goes through the lazy core ...
   ```

   如果看到 `no subscription configured yet` 警告，说明第 2 步没生效。

### 独立引擎（不用插件）

```bash
bun scripts/start-core.mjs   # 打印 CORE_READY pid=... port=17890，并保持运行
# 把你的应用指向 http://127.0.0.1:17890（HTTP/HTTPS 代理）
bun scripts/stop-core.mjs    # CORE_STOPPED pid=...
```

用 `LAZYPROXY_CONFIG_DIR` 指定其他配置目录。与插件的区别：脚本会一直保活内核，直到你手动停止。

### 卸载

1. 删除 `~/.config/opencode/plugins/lazy-proxy.js` 并重启 opencode。
2. 如内核仍在运行：`bun scripts/stop-core.mjs`（杀掉 `~/.config/lazyproxy/data/core.pid` 记录的进程）。
3. 可选：删除 `~/.config/lazyproxy/`（配置、生成的 `config.yaml`、已下载二进制）。

## 配置

配置文件：`~/.config/lazyproxy/config.json`（用 `LAZYPROXY_CONFIG_DIR` 覆盖目录）。首次运行自动生成默认值；只有 `subscriptionUrl` 必填。

| 键 | 默认值 | 说明 |
|-----|---------|-------------|
| `subscriptionUrl` | —（必填） | Clash/mihomo 格式订阅 URL。含你的 token——**不要提交、不要外发此文件**。 |
| `subscriptionFile` | — | 本地订阅 YAML；设置后优先于 `subscriptionUrl`（订阅端点不可达时有用）。 |
| `proxyHosts` | `["chatgpt.com","openai.com"]` | 经内核转发的主机（后缀匹配：`openai.com` 同时覆盖 `auth.openai.com`）。其余直连。shim 的 `upstream` 主机会自动加入。 |
| `excludeNodes` | — | 排除节点的正则（如 `hk|tw`——OpenAI 屏蔽部分区域）。 |
| `pinNode` | — | 钉死使用某个节点（精确名，优先级最高）。 |
| `shimPort` | `17891` | shim 监听端口（回环）。 |
| `corePort` | `17890` | mihomo mixed-port（回环）。 |
| `idleMs` | `180000` | 空闲多久后杀掉内核。 |
| `mihomoVersion` | `v1.19.32` | 要下载的 mihomo release tag。 |
| `corePath` | — | 使用已有的 mihomo 二进制；跳过自动下载。 |
| `downloadBaseUrl` | — | 覆盖下载基址（镜像 / ghproxy 前缀）。 |
| `upstream` | `https://api.openai.com` | shim 转发请求的默认上游（API-key 路径）。 |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error`。 |

说明：

- Token 安全：日志与报错中的 URL 会脱敏（`token`、`key`、`secret`、`password` → `***`）。
- 首次下载会记录校验和（TOFU），存于 `data/bin/mihomo-<version>.sha256`。
- 订阅端点不可达时，可把订阅 YAML 存到本地并设置 `subscriptionFile`。

## 接入 opencode

### A) API-key 路径

在 `~/.config/opencode/opencode.json` 中：

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

shim 会把 `http://127.0.0.1:17891/...` 的请求经内核转发到 `upstream`（默认 `https://api.openai.com`），首个请求自动拉起内核。

### B) Chat OAuth 路径（Chat Plus/Pro）

Chat-OAuth 流程访问的是 `chatgpt.com` 和 `auth.openai.com`（不是 `api.openai.com`），baseURL 改指向的办法不适用：

1. 保持 `provider.openai.options.baseURL` **不设置**（默认）。
2. 插件在 opencode 进程内打 `globalThis.fetch` 补丁：命中 `proxyHosts` 的请求经 shim（CONNECT）转发，其余 URL 走原始 fetch。必须这样做，是因为 OpenCode Desktop 的 provider 调用使用 Node 内置 `fetch`（undici），它忽略 `HTTPS_PROXY`。同时插件还会在进程内注入代理环境变量，作为读取 env 的库的兜底。
3. 认证一次：`/connect` → OpenAI → Chat Plus/Pro（浏览器）。
4. 使用 Codex-with-Chat 支持的模型（如 `gpt-5.6-luna`）；不相关的模型 ID 会被上游拒绝。

> **不要设置系统级/用户级 `HTTPS_PROXY`。** 那会劫持整台机器的所有应用——内核一旦没在跑，全部请求一起挂（早期的手动配置就是这么翻车的）。`lazy-proxy` 把代理范围限定在 opencode 进程内。

## 故障排查

| 症状 | 原因 / 处理 |
|---------|-------------|
| `Cannot connect ... ECONNREFUSED 127.0.0.1:17890` | 有东西直连了**内核**端口而内核没在跑（典型：残留的用户级 `HTTPS_PROXY=http://127.0.0.1:17890`）。应用不应直连内核端口——走 shim（baseURL），或交给插件处理。清掉残留代理环境变量（Windows：`reg query HKCU\Environment`；也检查"系统属性 → 环境变量"）并重启应用。 |
| opencode 日志出现 `failed to load plugin` | 插件加载时崩溃。确认安装的是最新的 `dist/plugin.js`。插件设计上加载期绝不抛错；若仍出现，保留日志行并反馈。 |
| 重启后没有 `[lazy-proxy] shim on ...` 日志 | `subscriptionUrl` 还是空的——填好 `config.json` 后重启 opencode。 |
| opencode 运行中 `17891` 无监听 | 插件未加载或已崩溃（见上）。 |
| OpenAI 返回 `403` | 出口区域被屏蔽（如 HK/TW）。用 `pinNode` 钉美/日节点，或用 `excludeNodes` 排除受限地区。 |
| 内核起不来 | 在终端跑 `bun scripts/start-core.mjs` 看报错；手动运行 mihomo（`data/bin/mihomo-<version>.exe -d <配置目录>/data`）看内核日志。GitHub 被墙 → 设置 `downloadBaseUrl`，或预放二进制并设置 `corePath`。 |
| shim 端口报 `EADDRINUSE` | 已有实例占用 `shimPort`，插件会复用它。若不是你想要的，改 `shimPort`。 |
| 确认监听情况 | Windows：`netstat -ano | findstr 1789`；macOS/Linux：`lsof -iTCP:17890 -sTCP:LISTEN`。opencode 运行期间应有 `17891`；`17890` 只在请求进行中（或空闲计时未到时）存在。 |

## 安全性

- **仅回环** —— shim 与内核都绑定 `127.0.0.1`。
- **无中间人** —— CONNECT 隧道是裸 TCP；TLS 在真实服务器终结。代理只能看到主机名，看不到明文。
- **无持久化系统改动** —— 不写系统代理、TUN、防火墙规则、用户/系统级环境变量。代理 env 仅在进程内注入，插件卸载时移除。
- **密钥处理** —— `config.json` 保存你的订阅 token，只留在本地；日志会对含 token 的查询参数脱敏。

## 开发

```
src/
  config/    配置 schema + 加载（校验、默认值、proxyHosts、脱敏）
  core/      mihomo 生命周期：二进制下载（TOFU）、配置生成、空闲看门狗、进程管理
  plugin/    opencode 入口：安全日志、进程级 env 注入、globalThis.fetch 补丁
  shim/      回环 HTTP + CONNECT shim（node:http）与传输工具
scripts/     start-core.mjs / stop-core.mjs / build.mjs
test/        vitest 单元 + 集成测试（fake mihomo core fixture）
```

```bash
bun install
bun test              # vitest 测试套件
bun run typecheck     # tsc --noEmit
bun run build         # esbuild 打包 -> dist/plugin.js
```

注意：

- `src/plugin/index.ts` 只导出 `LazyProxyPlugin`——请保持这一点（opencode 会自动加载插件的导出函数）。
- `dist/plugin.js` 是自包含 bundle；把它复制到 `~/.config/opencode/plugins/lazy-proxy.js` 即完成部署。

## 已知限制

- **Windows 优先**：自动下载与 `stop-core.mjs` 面向 Windows；其他平台需要 `corePath`。
- 请求体在内存中缓冲（对聊天大小的 JSON 没影响）。
- 空闲后的第一个请求要付冷启动成本（拉起内核 + 初始节点选择）。
- 每个配置目录只有一个内核；多个 opencode 进程共用（外部内核只复用、不杀）。

## 许可证与致谢

MIT —— 见 [LICENSE](LICENSE)。[mihomo](https://github.com/MetaCubeX/mihomo) 是独立项目，运行时下载，遵循其自己的许可证。
