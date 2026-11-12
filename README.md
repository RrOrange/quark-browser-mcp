# quark-browser-mcp

An MCP server that drives **the Quark browser you're already logged into**, over the Chrome DevTools Protocol.

Zero dependencies — `node:http` for the transport, Node 22+ global `WebSocket` for CDP.

```
node server.mjs --http 9311        # streamable HTTP at http://127.0.0.1:9311/mcp
node server.mjs                    # or stdio
```

中文说明见下方 [中文](#中文)。

---

## Why

Most browser MCP servers launch a fresh Chrome profile, so you're logged out of everything.

This one attaches to a running Chromium browser that already has your cookies, sessions and extensions —
so an agent can act as **you** on sites you're signed in to, without a login dance every time.

It was built for the [Quark](https://www.quark.cn/) PC client (a Chromium 144 derivative), but the
protocol is plain CDP, so any Chromium with `--remote-debugging-port` works: Chrome, Edge, Brave, CentBrowser, …

## Requirements

- Node.js **22+** (for the built-in `WebSocket`)
- A Chromium-based browser started with a debugging port:

```
your-browser.exe --remote-debugging-port=9223
```

Verify: `curl http://127.0.0.1:9223/json/version` should return JSON.

## Run

```bash
git clone <this repo>
cd quark-browser-mcp

# HTTP transport (easiest for MCP clients that take a URL)
node server.mjs --http 9311

# stdio transport
node server.mjs
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `QUARK_CDP` | `http://127.0.0.1:9223` | where the browser's CDP endpoint lives |

Register with any MCP client:

```bash
# Claude Code
claude mcp add --transport http quark-browser http://127.0.0.1:9311/mcp
```

For clients that only speak stdio, point them at `node /path/to/server.mjs`.

## Tools

| Tool | What it does |
|---|---|
| `browser_tabs` | list tabs (id / title / url) |
| `browser_open` | open a new tab at a url |
| `browser_navigate` | navigate the current tab |
| `browser_snapshot` | text snapshot: url, title, and `[n]`-numbered interactive elements |
| `browser_click` | click `ref` (scrolls into view → mousedown/mouseup/click), returns a fresh snapshot by default |
| `browser_type` | fill `ref` using the native value setter (works with React controlled inputs) |
| `browser_press` | dispatch a key: `Enter`, `Tab`, `Escape`, `Control+a` |
| `browser_eval` | run JS in the page, return a JSON-serialisable value |

Typical session:

```
browser_open     {"url":"https://music.163.com"}
browser_snapshot {}
browser_type     {"ref":3,"text":"周杰伦"}
browser_press    {"key":"Enter"}
browser_click    {"ref":7}
```

## Design notes

- **The snapshot is the addressing scheme.** Every snapshot rewrites `data-qb-ref` on the elements it
  returns, so old refs die immediately. The model has to look before it acts — no stale CSS selectors.
- **Click scrolls first.** `scrollIntoView({block:'center'})`, then dispatch `mousedown`/`mouseup`/`click`
  at the element's centre, so lazy-loaded and half-visible targets still work.
- **Typing uses the native setter.** `HTMLInputElement.prototype`'s `value` setter plus `input`/`change`
  events — React and Vue controlled components see it as real input.
- **Snapshot comes back with the action.** Click returns the resulting page state in the same call,
  which halves the round trips.

## Tested

Target: Quark PC `7.4.9.1045`, `Chrome/144.0.7559.86`.

```
GET  /health                 → {"ok":true,"cdp":"http://127.0.0.1:9223"}
initialize                   → protocolVersion 2025-06-18
tools/list                   → 8 tools
browser_tabs                 → 8 real tabs
browser_open example.com     → new tab id=01D07EA3…
browser_snapshot             → URL/TITLE/REFS:1 → [1] a "Learn more" -> https://iana.org/…
browser_eval document.title  → "Example Domain | https://example.com/"
browser_type   {ref:1}       → typed into [1] input
browser_click  {ref:2}       → clicked [2] button
verify        document.title  → "clicked:hello-mcp"     ← page JS really ran
```

## Security

The debugging port is **full control of the browser**, including every logged-in session.

- Keep it on `127.0.0.1`; never expose it on a LAN interface or forward it publicly.
- If you need it from another machine, tunnel it (`ssh -L 9223:127.0.0.1:9223 …`).
- Chromium only binds the debugging port to loopback by default — keep it that way.

## Roadmap

- screenshot tool (`Page.captureScreenshot`) for vision models
- explicit tab switch / close tools
- optional ref-less coordinate clicking

## License

MIT

---

## 中文

给 MCP 客户端一套浏览器工具，直接操作**你已登录的浏览器**：列标签页、导航、文本快照（带 `[n]` 编号）、
点击、输入、按键、执行 JS。零依赖，只要 Node 22+。

和大多数浏览器 MCP 的区别：它们会新起一个干净的 Chrome（所以什么都没登录），
这个只是**附加**到你正在跑的那个 Chromium 上，cookie、登录态、插件全在。

要求浏览器带调试端口启动：

```
your-browser.exe --remote-debugging-port=9223
curl http://127.0.0.1:9223/json/version     # 有 JSON 就成
```

运行：

```bash
node server.mjs --http 9311     # 流式 HTTP：http://127.0.0.1:9311/mcp
node server.mjs                 # 或 stdio
```

设计要点：

- **快照即寻址**：每次快照重排 `data-qb-ref`，旧编号立刻失效，逼模型"先看再点"，不用 CSS selector；
- **点击先滚动**：`scrollIntoView` 后按元素中心派发事件，懒加载/半可见目标也能点中；
- **输入走原生 setter**：React / Vue 受控组件也会当成真实输入；
- **动作默认回带快照**：一次调用拿到"点了 + 现在长什么样"，少一轮往返。

安全：调试端口等于整个浏览器的控制权（含所有登录态），只留 `127.0.0.1`，要跨机就 SSH 隧道。
