# quark-browser-mcp

**English** · [简体中文](README.zh-CN.md)

An MCP server that drives **the browser you're already logged into**, over the Chrome DevTools Protocol.

Zero dependencies — `node:http` for the transport, Node 22+ global `WebSocket` for CDP.

```bash
node server.mjs --http 9311        # streamable HTTP at http://127.0.0.1:9311/mcp
node server.mjs                    # or stdio
```

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

```bash
your-browser.exe --remote-debugging-port=9223
```

Verify: `curl http://127.0.0.1:9223/json/version` should return JSON.

> Pick a free port. If another browser already uses `9222`, pass it a different one — this server
> defaults to `9223` and can be pointed anywhere with `QUARK_CDP`.

## Install

```bash
git clone https://github.com/RrOrange/quark-browser-mcp.git
cd quark-browser-mcp
```

No `npm install` needed — there are no dependencies.

## Run

```bash
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

### Health check

```bash
curl http://127.0.0.1:9311/health
# {"ok":true,"cdp":"http://127.0.0.1:9223"}
```

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
browser_open      {"url":"https://music.163.com"}
browser_snapshot  {}
browser_type      {"ref":3,"text":"周杰伦"}
browser_press     {"key":"Enter"}
browser_click     {"ref":7}
```

Every tab target accepts an optional `target_id`; omit it to act on the first page.

## Design notes

- **The snapshot is the addressing scheme.** Every snapshot rewrites `data-qb-ref` on the elements it
  returns, so old refs die immediately. The model has to look before it acts — no stale CSS selectors.
- **Click scrolls first.** `scrollIntoView({block:'center'})`, then dispatch `mousedown`/`mouseup`/`click`
  at the element's centre, so lazy-loaded and half-visible targets still work.
- **Typing uses the native setter.** `HTMLInputElement.prototype`'s `value` setter plus `input`/`change`
  events — React and Vue controlled components see it as real input.
- **Snapshot comes back with the action.** Click returns the resulting page state in the same call,
  which halves the round trips.
- **Text snapshots, not screenshots.** Interactive elements only, capped at 500 per snapshot, labels
  truncated to 80 characters — cheap in tokens and good enough to drive a page.

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

Works with any Chromium exposing CDP; the table just records what this was verified against.

## Security

The debugging port is **full control of the browser**, including every logged-in session.

- Keep it on `127.0.0.1`; never expose it on a LAN interface or forward it publicly.
- If you need it from another machine, tunnel it (`ssh -L 9223:127.0.0.1:9223 …`).
- Chromium only binds the debugging port to loopback by default — keep it that way.
- An agent with these tools can read anything the browser can read. Grant it deliberately.

## Roadmap

- screenshot tool (`Page.captureScreenshot`) for vision models
- explicit tab switch / close tools
- optional ref-less coordinate clicking
- optional `--allow-origin` for restricted HTTP clients

## License

MIT