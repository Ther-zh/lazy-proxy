# lazy-proxy

opencode 请求级按需代理插件（A 阶段，仅 Windows）。

## 状态

- A 阶段（自用）：opencode 插件形态，开发中。
- B 阶段（社区）：抽独立引擎 + standalone CLI + 公开仓库。

## 目标行为

- 只监听 `127.0.0.1`；opencode 的 openai `baseURL` 指向插件 shim（默认 17891）。
- 首个请求到达时拉起 mihomo 核心（默认 mixed-port 17890），自动下载核心 + 直连机场订阅。
- 空闲 3 分钟（可配）后杀掉核心进程。其他应用零影响。

## 开发

```bash
bun install
bun test        # vitest
bun run typecheck
bun run build   # 打包插件 → dist/plugin.js
```

文档/账本见 `devflow/changes/lazyproxy-opencode-mvp/`。
