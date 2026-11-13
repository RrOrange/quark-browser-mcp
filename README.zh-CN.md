# quark-browser-mcp

[English](README.md) · **简体中文**

一个 MCP server，通过 Chrome DevTools Protocol 直接操作**你已登录的那个浏览器**。

零依赖 —— HTTP 用 `node:http`，CDP 用 Node 22+ 内置的全局 `WebSocket`。

```bash
node server.mjs --http 9311        # 流式 HTTP：http://127.0.0.1:9311/mcp
node server.mjs                    # 或 stdio
```

---

## 为什么做这个

大多数浏览器 MCP 会新起一个干净的 Chrome profile，所以你什么都没登录。

这个只是**附加**到你正在跑的 Chromium 上：cookie、登录态、插件全在，
agent 可以像**你本人**一样操作那些已登录的站点，不用每次重新登录。

它最初是为 [夸克](https://www.quark.cn/) PC 客户端（Chromium 144 衍生）写的，
但协议是标准 CDP，任何带 `--remote-debugging-port` 的 Chromium 都能用：
Chrome、Edge、Brave、百分浏览器……

## 环境要求

- Node.js **22+**（要用内置的 `WebSocket`）
- 带调试端口启动的 Chromium 系浏览器：

```bash
your-browser.exe --remote-debugging-port=9223
```

验证：`curl http://127.0.0.1:9223/json/version` 能返回 JSON 就成。

> 端口自己挑一个空闲的。如果 `9222` 已被别的浏览器占了，就换一个 ——
> 本项目默认 `9223`，也可以用 `QUARK_CDP` 指到任意地址。

## 安装

```bash
git clone https://github.com/RrOrange/quark-browser-mcp.git
cd quark-browser-mcp
```

不需要 `npm install` —— 没有依赖。

## 运行

```bash
# HTTP 传输（MCP 客户端能填 URL 的话最省事）
node server.mjs --http 9311

# stdio 传输
node server.mjs
```

环境变量：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `QUARK_CDP` | `http://127.0.0.1:9223` | 浏览器的 CDP 地址 |

注册到任意 MCP 客户端：

```bash
# Claude Code
claude mcp add --transport http quark-browser http://127.0.0.1:9311/mcp
```

只支持 stdio 的客户端，指向 `node /path/to/server.mjs` 即可。

### 健康检查

```bash
curl http://127.0.0.1:9311/health
# {"ok":true,"cdp":"http://127.0.0.1:9223"}
```

## 工具

| 工具 | 作用 |
|---|---|
| `browser_tabs` | 列出标签页（id / 标题 / URL） |
| `browser_open` | 新开标签页并导航 |
| `browser_navigate` | 当前标签页跳转 |
| `browser_snapshot` | 文本快照：URL、标题，以及带 `[n]` 编号的可交互元素 |
| `browser_click` | 点 `ref`（先滚进视口，再派发 mousedown/mouseup/click），默认回带新快照 |
| `browser_type` | 用原生 setter 填 `ref`（React 受控组件也认） |
| `browser_press` | 发按键：`Enter`、`Tab`、`Escape`、`Control+a` |
| `browser_eval` | 在页面执行 JS，返回 JSON 可序列化的值 |

典型一轮：

```
browser_open      {"url":"https://music.163.com"}
browser_snapshot  {}
browser_type      {"ref":3,"text":"周杰伦"}
browser_press     {"key":"Enter"}
browser_click     {"ref":7}
```

所有工具都收可选的 `target_id`；不传就作用在第一个标签页。

## 设计取舍

- **快照即寻址**：每次快照重排 `data-qb-ref`，旧编号立刻失效。
  逼模型"先看再点"，不用 CSS selector，也不会拿着过期选择器点空。
- **点击先滚动**：`scrollIntoView({block:'center'})` 后按元素中心派发事件，
  懒加载和半可见的目标也能点中。
- **输入走原生 setter**：`HTMLInputElement.prototype` 的 `value` setter 加 `input`/`change` 事件，
  React / Vue 受控组件会当成真实输入。
- **动作默认回带快照**：一次调用拿到"点了 + 现在长什么样"，少一轮往返。
- **文本快照而非截图**：只列可交互元素，单次上限 500 个、标签截断到 80 字符 ——
  省 token，也够驱动页面。

## 实测

目标：夸克 PC `7.4.9.1045`，`Chrome/144.0.7559.86`。

```
GET  /health                 → {"ok":true,"cdp":"http://127.0.0.1:9223"}
initialize                   → protocolVersion 2025-06-18
tools/list                   → 8 个工具
browser_tabs                 → 8 个真实标签页
browser_open example.com     → 新标签 id=01D07EA3…
browser_snapshot             → URL/TITLE/REFS:1 → [1] a "Learn more" -> https://iana.org/…
browser_eval document.title  → "Example Domain | https://example.com/"
browser_type   {ref:1}       → typed into [1] input
browser_click  {ref:2}       → clicked [2] button
验证         document.title  → "clicked:hello-mcp"     ← 页面 JS 真的执行了
```

任何暴露 CDP 的 Chromium 都能用；这张表只是记录验证时的环境。

## 安全

调试端口等于**整个浏览器的控制权**，含所有已登录会话。

- 只留 `127.0.0.1`，别绑到局域网网卡，更别转发到公网；
- 要跨机器用就走隧道（`ssh -L 9223:127.0.0.1:9223 …`）；
- Chromium 默认只把调试端口绑在 loopback，保持这个默认；
- 拿到这些工具的 agent，能读到浏览器能读到的一切 —— 给之前想清楚。

## 路线图

- 截图工具（`Page.captureScreenshot`），给视觉模型用
- 显式的标签页切换 / 关闭
- 可选的免 ref 坐标点击
- 可选的 `--allow-origin`，给受限的 HTTP 客户端

## 许可

MIT