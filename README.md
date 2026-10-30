# ds-web-mcp

把 **DeepSeek 网页版**（chat.deepseek.com）封装成标准 MCP 服务器，供任何支持
[Model Context Protocol](https://modelcontextprotocol.io) 的客户端调用
（OpenClaw、Claude Desktop、Cursor、Cline 等）。

核心价值：**直接用 DeepSeek 网页版自带的联网搜索**，不需要额外的搜索 API、不需要
搜索服务商账号、不产生额外费用。

```
MCP client ──stdio──> ds-web-mcp ──HTTPS──> chat.deepseek.com
```

## 特性

- **联网搜索** — 走 DeepSeek 网页内置的联网检索，实时内容
- **零构建** — 纯 TypeScript 源码，靠 Node 原生类型擦除直接运行
- **凭证自愈** — token 失效时自动从已登录的浏览器 profile 重新抓取，无需人工
- **跨平台** — Windows / macOS / Linux，自动探测 Chrome、Chromium、Edge、Brave、Vivaldi
- **浏览器指纹** — TLS / HTTP/2 / 请求头对齐真实 Chrome（见下文）
- **令牌隔离** — 复用 DeepSeek 官方 PoW WebAssembly，不绕过任何风控

## 要求

- **Node.js >= 22.6**（需要原生 TypeScript 类型擦除）
- 一个 Chromium 系浏览器（仅 `login` / 自动刷新时需要）

## 安装

从 GitHub 克隆后安装：

```bash
git clone https://github.com/GHub-YM/ds-web-mcp.git
cd ds-web-mcp
npm install
```

也可以全局安装，安好后在任何目录都能直接调用 `ds-web-mcp`：

```bash
npm install -g .
ds-web-mcp --help
```

也可以不克隆，直接跑 `npm pack` 产出的 tarball（见「分发到其他电脑」）。

## 分发到其他电脑

依赖只有 2 个（`@modelcontextprotocol/sdk`、`zod`），**全是纯 JS，没有任何原生模块
或平台二进制**（`node_modules` 里 `.node` 文件数为 0）。因此 Windows / macOS / Linux
之间可以互相拷贝，不需要重编译。

### 方式 A：打包分发（推荐，79 KB）

在源机器生成运行时包（不含 `node_modules` 与 `tools/`）：

```bash
npm pack          # 产出 ds-web-mcp-0.3.0.tgz
```

把 `.tgz` 拷到目标机器，然后：

```bash
mkdir ds-web-mcp && tar -xzf ds-web-mcp-0.3.0.tgz -C ds-web-mcp --strip-components=1
cd ds-web-mcp
npm install
node bin/ds-web-mcp.mjs --version
```

### 方式 B：整目录拷贝（最省事，14 MB）

把整个项目目录（**含 `node_modules`**）直接拷过去即可，连 `npm install` 都能跳过。
因为无原生模块，换机器、换系统都能直接跑。

```bash
node bin/ds-web-mcp.mjs --version   # 无需安装步骤
```

> 别只拷 `src/`——那样缺依赖。要拷就整个目录。

### 两种方式都要做的

**1. 目标机器要有 Node >= 22.6**

```bash
node --version    # 需 >= 22.6.0
```

**2. 登录（每台机器各自一次）**

凭据保存在**用户 home 目录**（`~/.ds-web-mcp.json`、`~/.ds-web-mcp-chrome`），
不在项目目录里。所以拷项目**不会**带走登录态，目标机器要自己登录一次：

```bash
node bin/ds-web-mcp.mjs login     # 需要本机有 Chromium 系浏览器
node bin/ds-web-mcp.mjs status    # 确认 token / cookie / deviceId 都在
```

**3. 把 MCP 客户端指向新位置**（绝对路径）

注意：OpenClaw 的命令行支持 `\` 续行（bash、zsh、Windows 的 Git Bash 都适用），
但 **PowerShell 里会直接报语法错误**（`一元运算符 '--' 后缺少表达式`）。
PowerShell 请写一整行，或用反引号 `` ` `` 续行：

```powershell
# PowerShell：单行
openclaw mcp add deepseek-web --command node --arg "D:\ds-web-mcp\bin\ds-web-mcp.mjs" --arg run
```

```bash
# bash / zsh / Git Bash：可以用 \ 续行
openclaw mcp add deepseek-web \
  --command node \
  --arg "/目标机器/绝对路径/ds-web-mcp/bin/ds-web-mcp.mjs" \
  --arg run
```

这行命令在干什么：它就是本项目 README「接入 MCP 客户端」那节的第一种写法，
只是路径换成了目标机器上的路径。各段含义：

| 片段 | 含义 |
| --- | --- |
| `openclaw mcp add deepseek-web` | 在 OpenClaw 的 MCP 注册表里新增一个名叫 `deepseek-web` 的服务器 |
| `--command node` | 启动方式：跑 `node` |
| `--arg "...bin/ds-web-mcp.mjs"` | 传给 node 的第 1 个参数：入口脚本的**绝对路径** |
| `--arg run` | 第 2 个参数：以 stdio MCP server 模式运行 |

合起来等价于写进 `~/.openclaw/openclaw.json`：

```json
{
  "mcp": {
    "servers": {
      "deepseek-web": {
        "command": "node",
        "args": ["D:\\ds-web-mcp\\bin\\ds-web-mcp.mjs", "run"]
      }
    }
  }
}
```

`openclaw mcp add` 会**先试连一次再保存**。不想试连就加 `--no-probe`，
之后用 `openclaw mcp probe deepseek-web` 单独测。

### 关于携带凭据

`~/.ds-web-mcp.json` 只有 515 字节，包含 `token`(64)、`cookie`、`deviceId`，
把它拷到目标机器可以免登录。**但这条路径未经实测**，且凭据含登录态，请自行判断；
让每台机器各自 `login` 是更干净的做法。

### 安装到客户端目录（装完可删原目录）

想在目标机器上把副本装进 MCP 客户端自己的目录、之后原项目可删可移：

```bash
node tools/install-to-mcp-homes.mjs
```

详见 `tools/README.md`。注意该脚本要**连 `tools/` 一起拷**（`npm pack` 的包不含它）。

## 使用

### 1. 登录（只需一次）

```bash
ds-web-mcp login
```

会打开一个浏览器窗口，登录你的 DeepSeek 账号即可。脚本会自动检测登录完成、
保存凭证，窗口可以随后关闭。

> 登录态保存在**专用浏览器 profile** 中（默认 `~/.ds-web-mcp-chrome`），与你日常
> 使用的浏览器完全隔离。**这个目录请保留** —— 自动刷新 token 依赖它。

### 2. 检查

```bash
ds-web-mcp doctor
```

```
ds-web-mcp doctor

  [ok]   Node.js >= 22              v24.16.0
  [ok]   Chromium-family browser    C:\Program Files\Google\Chrome\Application\chrome.exe
  [ok]   Browser profile            C:\Users\you\.ds-web-mcp-chrome
  [ok]   Credential configured      token 64 chars
  [ok]   Browser fingerprint        win Chrome 153, captured values, curve X25519MLKEM768:X25519:P-256:P-384, protocol auto
  [ok]   Live credential check      token accepted by chat.deepseek.com

All checks passed.
```

### 3. 接入 MCP 客户端

**OpenClaw**

```bash
openclaw mcp add deepseek-web \
  --command node \
  --arg "/absolute/path/to/ds-web-mcp/bin/ds-web-mcp.mjs" \
  --arg run
openclaw mcp probe deepseek-web
```

**Codex**

```bash
codex mcp add deepseek-web -- node "/absolute/path/to/ds-web-mcp/bin/ds-web-mcp.mjs" run
codex mcp list
```

也可以直接写 `~/.codex/config.toml`：

```toml
[mcp_servers.deepseek-web]
command = 'node'
args = ['/absolute/path/to/ds-web-mcp/bin/ds-web-mcp.mjs', 'run']
```

**Claude Desktop / Claude Code**

```json
{
  "mcpServers": {
    "deepseek-web": {
      "command": "node",
      "args": ["/absolute/path/to/ds-web-mcp/bin/ds-web-mcp.mjs", "run"]
    }
  }
}
```

**Cursor / Cline / 其他**

任何支持 stdio 传输的 MCP 客户端都适用，命令同上。

> 注册名建议固定用 `deepseek-web`——工具名由它派生，改名会改变调用方看到的工具名。
> 配置里写**绝对路径**，但这个项目**不依赖 cwd**，用哪个工作目录启动都可以。

## 工具

| 工具 | 说明 |
|---|---|
| `web_search` | **主力工具。** 开启 DeepSeek 联网搜索提问，返回答案 + 会话链接。 |
| `chat` | 普通提问。`search=true` 可临时开联网；`sessionId` + `parentMessageId` 可续接会话；`refFileIds` 可附上已上传的文件。 |
| `upload_files` | **上传本地文件**（图片 / PDF / 文档 / 代码 / 压缩包），返回文件 id。把 id 当作 `chat` 的 `refFileIds` 传回去即可附加。单文件上限 100 MB。 |
| `list_files` | 按文件 id 查服务端元数据（文件名、大小、类型、上传状态、内容审核结果）。 |
| `new_session` | 新建空会话，返回 id 与 URL。 |
| `refresh_token` | 手动从浏览器重新抓取 token。 |
| `diagnose` | 检查凭证是否被接受，并报告自动刷新状态。 |

### 上传与附件用法

分两步：先上传拿 id，再在提问时引用。

```
1) upload_files { filePaths: ["D:/tmp/photo.png", "D:/tmp/report.pdf"] }
   → id=<file-id-1> name=photo.png ...
   → id=<file-id-2> name=report.pdf ...

2) chat { prompt: "对比这两份文件的差异", refFileIds: ["<file-id-1>", "<file-id-2>"] }
```

要点：

- 上传本身**不附加**到任何会话，只是把文件放进账号的文件库；只有被 `refFileIds` 引用才会进入对话。
- 内容类型按扩展名推断（`src/upload.ts` 的映射表），未知扩展名按 `application/octet-stream` 发送，服务端可能因此拒绝——`audit` 字段会反映审核结果。
- **服务端不在上传响应里返回 mime 类型**；`type=` 是本项目按扩展名本地推断的，不是服务端声明。`list_files` 查回的记录里该字段通常为空。
- 文件名、扩展名大小写不敏感；路径支持绝对与相对，相对路径按 MCP 服务器进程的工作目录解析。
- 上传失败会带明确原因（文件不存在 / 是目录 / 为空 / 超限 / 读取中途变化），不会静默当成成功。
- 校验顺序是**先 stat 再读**：超限文件在读入内存之前就被拒绝。

### 上传的状态流转

上传是一次**异步处理**，返回的 `status` 不是终态：

```
upload_files  → status=PENDING   记录已创建，内容尚未解析
list_files    → status=PARSING   服务端解析中（model_kind 会标明解析方向）
              → status=SUCCESS   解析完成，可正常引用
```

因此：

- 想确认解析结果，隔一会儿用 `list_files` 再查一次，直到 `status` 变成终态。
- `signedPath` / `auditResult` 在解析完成前为 `null`，属正常。
- 附件可以在 `PENDING` / `PARSING` 阶段就被 `refFileIds` 引用；服务端会等待解析。

### 上传路由的协议细节

上传走 `POST /api/v0/file/upload_file`，头集合按**真实成功上传（HTTP 200）抓包**对齐，不是推测的。三处容易踩：

- **上传路由有独立的 PoW。** `x-ds-pow-response` 的 payload 里 `target_path` 必须是 `/api/v0/file/upload_file`；复用 completion 路由的 PoW 会被拒。
- **`x-file-size` 是文件内容字节数**，不是 multipart 信封大小（两者差一个边界和头部的长度）。
- **响应体没有包裹层。** 文件记录直接就是 `biz_data`，形如 `{id, status, file_name, file_size, model_kind, ...}`，不存在 `file` / `files` 键。

这三个坑的表现各不相同：缺少 PoW 时服务端回 `40300 MISSING_HEADER`（这个错误码把原因说成"缺头"，实际是**缺 PoW 签名**）；响应形状判断错误则会把一次**成功的上传**误报成失败。

`web_search` 调用示例输出：

```
今天（2026年9月18日）有多条开源软件相关新闻…
- 全球首个 3D 算力芯片编程模型开源：Open3D-PIMC…
- MiniMax Code CLI 正式开源（MIT 协议）…
- 阿里 DAMO RADAR 登上《Science》并开源…

---
Session: https://chat.deepseek.com/a/chat/s/<id>
```

## 凭证与自动续取

### 登录是长期的吗？

是。实测结论：

| 问题 | 结论 |
|---|---|
| 关浏览器后还在吗 | **在**，重新打开会自动恢复会话 |
| token 会过期吗 | 会，但**能自动重新抓取** |
| 何时需要人工登录 | 仅在服务端吊销后（改密码、主动登出） |

### 自动自愈

MCP 服务器内置 `withAuthRefresh()`：任何工具遇到鉴权失败时，自动

```
启动 headless 浏览器（复用已登录 profile）
  → 等页面恢复会话
  → 读取并解包 userToken
  → 写回配置文件
  → 重建客户端，重试原操作
```

只重试一次，不会死循环。实测把凭证换成伪造值后，服务器在 **3.2 秒内**自动恢复。

关闭自动刷新：`DS_NO_AUTO_REFRESH=1`。

### 配置热重载

server 会缓存客户端。为了让**外部改动**（手动编辑配置文件、在别处跑 `ds-web-mcp refresh`）
无需重启即可生效，每次调用前都会重新读取配置并与缓存比对：

- 配置无变化 → 直接用缓存，零额外开销
- 配置有变化 → 重建客户端
- 配置文件暂时损坏 → 继续用上一个可用配置，不中断服务

这样 token 外部更新后，下一次工具调用就会用上新凭证。

### 手动刷新

```bash
ds-web-mcp refresh           # 静默刷新
ds-web-mcp refresh --check   # 只检查，不写入
```

退出码 `0` = 成功，`2` = 需要人工登录。

## 配置

凭证默认保存在 `~/.ds-web-mcp.json`（权限 0600）。

```json
{
  "token": "<64 字符 bearer>",
  "cookie": "<可选，原始 Cookie 头>",
  "deviceId": "<可选，x-device-id>",
  "appVersion": "2.5.0",
  "locale": "zh_CN"
}
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DS_TOKEN` | — | 直接指定 bearer，跳过浏览器 |
| `DS_COOKIE` | — | 原始 Cookie 头 |
| `DS_DEVICE_ID` | — | `x-device-id` |
| `DS_BROWSER` | 自动探测 | 浏览器可执行文件路径 |
| `DS_CHROME_PROFILE` | `~/.ds-web-mcp-chrome` | 专用 profile 目录 |
| `DS_CHROME_DEBUG_PORT` | `9334` | 自动刷新时的调试端口 |
| `DS_BASE_URL` | `https://chat.deepseek.com` | 路由 origin 覆盖（测试用） |
| `DS_TIMEOUT_MS` | `180000` | 单轮请求预算 |
| `DS_APP_VERSION` | `2.5.0` | `x-client-version` |
| `DS_LOCALE` | `zh_CN` | `x-client-locale` |
| `DS_NO_AUTO_REFRESH` | — | 设为 `1` 关闭自动刷新 |
| `DS_WEB_MCP_CONFIG` | `~/.ds-web-mcp.json` | 配置文件路径 |
| `DS_FINGERPRINT` | `chrome` | `off` 可退回旧行为（Node 默认 UA、无浏览器头） |
| `DS_FINGERPRINT_PLATFORM` | `win` | 指纹平台：`win` / `mac` / `linux` |
| `DS_CHROME_VERSION` | 自动探测 | UA 与 client hints 用的 Chrome 主版本 |
| `DS_USER_AGENT` | — | 完整 UA 覆盖（逃生口） |
| `DS_HTTP_PROTOCOL` | `auto` | `auto`（https 走 h2）/ `h2` / `http1` |

### 手动指定凭证

不想让脚本碰浏览器时，可以自己贴 token：

```bash
export DS_TOKEN='<从浏览器 localStorage 取>'
```

取法：登录 chat.deepseek.com → F12 Console：

```js
JSON.parse(localStorage.getItem('userToken')).value
```

> ⚠️ `userToken` 存的是 JSON 信封 `{"value":"...","__version":"1"}`，**真实凭证是
> 内层的 `.value`**。把整个信封当 token 用会被服务端拒绝（`code 40003`）。
> 本项目的加载器会自动解包，两种写法都能接受。

## 命令行

```
ds-web-mcp <command> [options]

  login      登录并保存凭证（交互，仅需一次）
  refresh    从已保存的 profile 重新抓取 token（无需交互）
  status     显示配置、凭证形态、profile 位置
  doctor     检查环境前提与凭证健康度
  fingerprint  显示将要发送的浏览器指纹与已知差异
  run        以 stdio 运行 MCP 服务器（MCP 客户端调用）
  help       显示帮助

选项
  --browser <path>     指定浏览器可执行文件
  --visible            登录时显示浏览器窗口
  --json               机器可读输出（status/doctor）
  --timeout <seconds>  登录等待预算（默认 600）
```

`status` 与 `doctor` 的退出码：`0` 正常，`1` 需修复，`2` 需人工登录。

## 项目结构

```
bin/ds-web-mcp.mjs       可执行入口（处理 Node 版本差异）
src/
  cli.ts                 命令行
  server.ts              MCP 工具定义 + 鉴权自愈包装
  config.ts              配置加载、userToken 解包
  browser.ts             跨平台浏览器与 profile 探测
  fingerprint.ts         浏览器指纹画像与请求头顺序
  transport.ts           带指纹的 HTTP/2 / HTTP/1.1 传输层
  token-refresh.ts       从浏览器 profile 自动重抓 token
  upload.ts              本地文件读取 + multipart/form-data 组装
  deepseek-client.ts     会话创建 / PoW / 补全 / 流读取 / 文件上传
vendor/                  取自 deepseek-pp 的 DeepSeek 协议实现（Apache-2.0）
tests/                   测试套件
tools/                   开发期指纹抓取工具（不随包发布，见 tools/README.md）
NOTICE                   第三方来源与修改声明
```

### 浏览器指纹

默认情况下，请求按真实 Chrome 的形状发出，而不是 Node 默认形状。下列取值均在本机
真机 Chrome 153 上实测抓取（不是抄文档）：

| 层 | 内容 |
|---|---|
| 请求头 | `User-Agent`、`Sec-CH-UA` 三件套、`Accept-Language`、`Accept-Encoding: gzip, deflate, br, zstd`、`Sec-Fetch-Site/Mode/Dest`、`Origin`/`Referer`、`Priority` |
| 头序 | 与 Chrome 实际发出的 HPACK 顺序逐位一致（把 `chat.deepseek.com` 指到本地 h2 监听抓的） |
| TLS | Chrome 的 15 条 cipher 顺序、曲线偏好 `X25519MLKEM768:X25519:P-256:P-384`、ALPN `h2,http/1.1`、签名算法集 |
| HTTP/2 | Chrome 的 SETTINGS（`65536 / push off / 6291456 / 262144`）与连接级 `WINDOW_UPDATE delta=15663105` |

查看当前指纹与残留差异：

```bash
ds-web-mcp fingerprint
```

**已知无法复刻的差异**（`fingerprint` 命令会原样列出）：

- GREASE（cipher / 扩展 / 曲线 / 签名算法）
- `encrypted_client_hello`（ECH）与 `application_settings`（ALPS）
- ML-DSA 签名算法 `0x0904-0x0906`（Chrome 153 会发，OpenSSL 不支持）
- TLS 扩展顺序（OpenSSL 固定序，Chrome 自排）
- `key_share` 个数（Chrome 发 mlkem768 + x25519 两条，OpenSSL 只发第一条）

也就是说：**请求头、头序、HTTP/2 帧与 cipher 列表是逐位对齐的；TLS ClientHello 的扩展部分
只是接近，不是完全相同。** 上表差异是 OpenSSL 的能力边界，不是本项目可以补的。

实际影响：基于 **JA3 / JA4** 的指纹比对能够区分本客户端与真 Chrome（扩展集合与数量不同，
例如 Chrome 153 发送 17 个扩展、本项目发送 12 个）。请求头与 HTTP/2 帧层面的检测则无法区分。
**请勿把本项目当作「无法被检测」的方案。**

### 跨平台说明

Windows / macOS / Linux 均可使用：浏览器探测（Chrome、Chromium、Edge、Brave、Vivaldi）
与 Chrome 版本读取都按平台分支实现。

- Windows 从 `Application\<版本>\` 目录名读版本（Windows 上 `chrome.exe --version`
  只会弹窗，不输出）。
- macOS / Linux 执行 `<浏览器> --version`。Brave / Edge 会先打印自身版本、再在
  `Chromium:` 后打印引擎版本，本项目取**引擎版本**——否则会把品牌版本号写进 UA。
- 平台预设 `mac` / `linux` 的 UA 与平台令牌是按同构推导的，**未在真机实测**；
  `fingerprint` 会标注该预设属于推导值。建议这两个平台的用户跑一次
  `ds-web-mcp fingerprint` 对照本机真实 Chrome。

需要退回旧行为时：`DS_FINGERPRINT=off`。

### 关于 vendor/

`vendor/` 下的文件来自 [deepseek-pp](https://github.com/zhu1090093659/deepseek-pp)，
包含 DeepSeek 网页协议的权威实现：

- `request-codec.ts` — 路由表与请求编码（纯函数，零浏览器依赖）
- `stream-codec.ts` — SSE 流解析、片段分类（纯函数，零浏览器依赖）
- `pow.ts` — DeepSeekHashV1 工作量证明求解
- `sha3_wasm_bg.wasm` — DeepSeek 官方 PoW WebAssembly 模块

**私有协议逻辑一行未改。** 仅调整了 import 后缀和 WASM 加载方式（详见 `NOTICE`）。

## 测试

```bash
npm test              # 离线套件
npm run test:live     # + 对真实服务的探测（无需凭证）
npm run test:all      # + 需要登录的测试
```

| 覆盖 | 内容 |
|---|---|
| 协议 | MCP 握手、工具清单、注解 |
| CLI | help / version / status / doctor / 参数解析 |
| 编码 | PoW 求解（上游 fixture）、SSE 解析（文本级 + 字节级分片） |
| 兼容 | userToken 信封解包 |
| 行为 | mock 后端端到端、HTTP 200 包装的鉴权失败分类 |
| 线上 | 路由表比对、失效分类、content-type 守卫 |
| 指纹 | 头序逐位比对抓取值、client hints、HTTP/2 preface 帧、压缩解码 |
| 自愈 | 伪造失效凭证，验证自动恢复 |
| 热重载 | 运行中外部改写配置，验证无需重启即生效 |

## 已知限制

- 自动刷新需要本机装有 Chromium 系浏览器；纯服务器环境请用 `DS_TOKEN`。
- 每次 `web_search` 建新会话，会在你账号里留下记录。
- 上传的附件同样留在账号文件库里；本项目没有删除已上传文件的能力。
- 未实现：视频附件的时长/封面解析、工具调用 XML 解析、搜索引用结构解析。
- 已实现：图片 / PDF / 文档 / 代码 / 压缩包的本地文件上传，以及把上传结果作为附件引用接入对话。
- 指纹覆盖 TLS / HTTP/2 / 请求头三层；TLS ClientHello 的扩展部分与真机 Chrome 仍有
  差异（见「浏览器指纹」一节的已知差异清单）。
- 单轮无多轮记忆；续接请用 `chat` 传 `sessionId`。

