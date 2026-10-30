# tools/ — 开发期抓取工具

这里的脚本**不随 npm 包发布**（`package.json` 的 `files` 字段未包含 `tools/`）。

## install-to-mcp-homes.mjs — 安装到 MCP 客户端目录

把本项目安装进每个 MCP **客户端自己的** home 目录，并把客户端配置指向该副本。
装完后**原项目目录可以删除或随意移动**，客户端不再依赖它。

```bash
node tools/install-to-mcp-homes.mjs                 # OpenClaw + Codex
node tools/install-to-mcp-homes.mjs --dry-run       # 只看计划
node tools/install-to-mcp-homes.mjs --clients=codex # 只装一个
node tools/install-to-mcp-homes.mjs --force         # 允许覆盖已有目标
```

安装位置：

| 客户端 | 安装目录 | 配置 |
| --- | --- | --- |
| OpenClaw | `~/.openclaw/mcp-servers/ds-web-mcp` | `~/.openclaw/openclaw.json` → `mcp.servers.deepseek-web` |
| Codex | `~/.codex/mcp-servers/ds-web-mcp` | `~/.codex/config.toml` → `[mcp_servers.deepseek-web]` |

设计要点：

- **注册名保持 `deepseek-web`**，与原配置一致——工具名由它派生，改名会破坏调用方。
- **先复制到暂存目录再原子换入**，失败不会留下半个安装。
- **注册前先跑 MCP 握手验证**，不通就**不写配置**（避免写出一个运行时报错的条目）。
- **凭据不复制**：token 与浏览器 profile 始终在用户 home 下，所有客户端共享同一登录态，
  删掉任一安装都不会导致登出。
- 依赖全是纯 JS，无原生模块，副本可跨机器直接跑。
- 重跑会自动清理指向安装目录的**旧同义条目**，不会产生重复 server。

> 装完后需要**重启 MCP 客户端**才会生效（网关持有的旧子进程不会自动重启）。

## fingerprint-capture/ — 指纹抓取

当本机 Chrome 升级、或需要核对指纹是否仍然对齐时使用。

| 脚本 | 用途 |
| --- | --- |
| `probe-clienthello.mjs` | 把 Chrome 指向裸 TCP 监听，解析它发出的 TLS ClientHello（cipher / 扩展 / 曲线 / 签名算法） |
| `probe-chrome-hello.mjs` | 同上，另一版解析 |
| `probe-h2-settings.mjs` | 抓 HTTP/2 连接前言，解析 SETTINGS 与 WINDOW_UPDATE 原始帧 |
| `probe-h2-order.mjs` | 记录 HTTP/2 伪头与头序 |
| `probe-h1-order.mjs` | HTTP/1.1 路径的头序 |
| `probe-order.mjs` | 头序抓取 |
| `probe-chrome-headers.mjs` | 抓 Chrome 实际发出的请求头 |
| `probe-cdp-headers.mjs`、`probe-cdp2.mjs` | 经 CDP 抓真实线包头（`Network.requestWillBeSentExtraInfo`） |
| `probe-ua.mjs` | 抓 UA 与客户端提示 |
| `probe-constraints*.mjs` | 探测 Node/OpenSSL 的能力边界 |
| `probe-tls-final.mjs` | 汇总 TLS 层最终结论 |
| 其余 `probe-*.mjs` | 过程中用于定位单项差异的临时探针 |

### 重要方法论（踩过的坑）

- **CDP 返回的 headers 字典是字母序，不是真实线序。** 要拿真实顺序必须用
  `Network.requestWillBeSentExtraInfo`。
- **测 Chrome 指纹时不能让 Node 替它发请求。** 用 CDP + Node `fetch` 测到的是 Node
  （返回体会出现 `user_agent: "node"`）。必须让**页面自己**发请求。
- **`sec-fetch-*` 按请求类型变化。** 基准必须与被测场景同类型（同源 fetch 对同源 fetch），
  否则会把正常差异误判成不一致。
- Windows 上 Chrome **不支持 `--version`**（只会弹窗），读版本要列
  `Application\<版本>\` 目录名。

## scan.cjs

在仓库里搜索可能暴露「自动化/机器人」特征的字符串（`robot`、`headless`、`User-Agent` 等）。
排查指纹泄漏面时用：

```bash
node tools/scan.cjs
```
