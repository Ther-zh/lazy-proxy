# Spike 01: 插件内 HTTP 服务 + 上游传输定案

日期: 2026-10-05 · 环境: bun 1.3.14, opencode 1.18.18 (anomalyco fork), node v22.13.1, win32

## 结论
1. ✅ 插件内可跑长驻 Bun.serve，opencode 的 provider 流量会真实打到插件服务器。
2. ✅ 明文 TCP + 绝对形式 HTTP/1.1 → 本地代理核心 是最可靠的上游路径（TLS 交给核心）。
3. ❌ Bun 不支持 `tls.connect({ socket })`（`ERR_MISSING_ARGS`）→ 不可在 shim 内自建 CONNECT+TLS。
4. ⚠️ `Bun.fetch({ proxy })`：https 走 CONNECT（有日志），但 http 绝对形式不生效、且离线完成性不可证 → 弃用。

## 证据

- `PROBE-PLUGIN HIT POST /v1/responses bodyLen=193K`：插件服务器收到 opencode 请求（本 fork 用 Responses API，非 chat/completions）。
- `RAW-OK: got upstream bytes len=353`：Bun.connect → CONNECT 200 → 隧道内转发 → 本地上游响应 353B。
- `CONNECT example.com:443` ×2（proxy option 与 HTTPS_PROXY env 各一次）：Bun.fetch proxy 确实发起 CONNECT。
- `HTTPS-PROXY-LOCAL: PASS`（status=200 FAKE-TLS-OK）：注意回环目标被 Bun 隐式跳过代理，该结果只证明直连+TLS 环境可行，不证明代理路径。

## 关键技术事实（实现时要记住）
- `Bun.connect()` 返回 **Promise**（须 await）；socket 支持 `.data` 状态属性。
- `Bun.serve` 的 fetch handler 给的是解析好的 Request（method/headers/body 流），无需自己解析客户端侧字节。
- 响应侧 SSE 是 chunked 编码，shim 需 chunked 解码后再作为 Response body 流式返回。
- 插件项目根 = 最近 git 根；`.opencode/plugins/` 只在独立 git 仓库内生效。E2E 安装走全局 `~/.config/opencode/plugins/`。
- 生成测试证书：用 Git 自带 openssl（`D:\git\Git\usr\bin\openssl.exe`）；anaconda 的 openssl 缺配置文件。

## 对设计的影响（已回写 design.md）
- ShimServer 新增 PlainTCPTransport（明文 TCP → mihomo 绝对形式 HTTP/1.1 + chunked 解码）。
- 移除"Bun.fetch proxy 传输"作为主方案。
- E2E 插件安装方式明确：全局插件目录。
