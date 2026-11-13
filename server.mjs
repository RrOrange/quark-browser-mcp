// quark-browser-mcp —— 把夸克浏览器的标签页做成 MCP 工具
//
// 两种传输：
//   node server.mjs                  stdio（给支持 stdio 的客户端）
//   node server.mjs --http 9311      流式 HTTP，POST http://127.0.0.1:9311/mcp
//
// 原理：夸克是 Chromium。开 CDP（--remote-debugging-port=9223）后，用标准
// Chrome DevTools Protocol 列标签页、导航、快照、点击、输入、执行脚本。
// 不依赖 quantum.browserUse 的私有协议，也不需要 KBot 的 prompt。
//
// env:
//   QUARK_CDP   CDP 地址，默认 http://127.0.0.1:9223
import http from "node:http"

const CDP = (process.env.QUARK_CDP || "http://127.0.0.1:9223").replace(/\/+$/, "")

// ---------- CDP ----------

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(CDP + path, { timeout: 5000 }, (res) => {
      let raw = ""
      res.setEncoding("utf8")
      res.on("data", (c) => (raw += c))
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw))
        } catch {
          reject(new Error("CDP 返回的不是 JSON: " + raw.slice(0, 120)))
        }
      })
    })
    req.on("timeout", () => req.destroy(new Error(`CDP 连接超时，确认夸克带 --remote-debugging-port 启动（${CDP}）`)))
    req.on("error", (e) => reject(new Error(`连不上 CDP ${CDP}：${e.message}`)))
  })
}

class Session {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.opened = null
  }

  async open() {
    if (this.opened) return this.opened
    this.opened = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      this.ws = ws
      ws.addEventListener("open", () => resolve())
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")))
      ws.addEventListener("message", (ev) => {
        let msg
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "")
        } catch {
          return
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: ok, reject: no } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          msg.error ? no(new Error(`${msg.error.message} (${msg.error.code})`)) : ok(msg.result)
        }
      })
      ws.addEventListener("close", () => {
        for (const { reject: no } of this.pending.values()) no(new Error("CDP 连接已关闭"))
        this.pending.clear()
        this.opened = null
        this.ws = null
      })
    })
    return this.opened
  }

  async send(method, params = {}) {
    await this.open()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP ${method} 超时`))
        }
      }, 30000)
      t.unref?.()
    })
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(d.exception?.description || d.text || "页面脚本异常")
    }
    return r.result?.value
  }

  close() {
    try {
      this.ws?.close()
    } catch {}
  }
}

const sessions = new Map()

async function targets() {
  const list = await httpJson("/json/list")
  return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl)
}

async function pickTarget(targetId) {
  const all = await targets()
  if (!all.length) throw new Error("没有可用的标签页（夸克窗口里先打开一个页面）")
  const t = targetId ? all.find((x) => x.id === targetId) : all[0]
  if (!t) throw new Error(`找不到标签页 ${targetId}；现有：${all.map((x) => x.id).join(", ")}`)
  let s = sessions.get(t.id)
  if (!s || s.ws === null) {
    s = new Session(t.webSocketDebuggerUrl)
    sessions.set(t.id, s)
  }
  await s.open()
  return { session: s, target: t, all }
}

const SNAPSHOT_JS = `(() => {
  const SEL = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="menuitem"],[contenteditable="true"]';
  const seen = new Set(); const lines = []; let n = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (n >= 500) break;
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || el.disabled) continue;
    n += 1;
    el.setAttribute('data-qb-ref', String(n));
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').toString().replace(/\\s+/g, ' ').trim().slice(0, 80);
    const tag = el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '');
    const href = el.tagName === 'A' && el.href ? ' -> ' + String(el.href).slice(0, 100) : '';
    lines.push('[' + n + '] ' + tag + ' "' + label + '"' + href);
  }
  return 'URL: ' + location.href + '\\nTITLE: ' + document.title + '\\nREFS: ' + n + '\\n\\n' + lines.join('\\n');
})()`

const CLICK_JS = (ref) => `(() => {
  const el = document.querySelector('[data-qb-ref="${ref}"]');
  if (!el) return 'ERR ref ${ref} 不存在，先重新 snapshot';
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const opt = { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  el.dispatchEvent(new MouseEvent('mousedown', opt));
  el.dispatchEvent(new MouseEvent('mouseup', opt));
  el.click();
  return 'clicked [' + ${ref} + '] ' + el.tagName.toLowerCase();
})()`

const TYPE_JS = (ref, text) => `(() => {
  const el = document.querySelector('[data-qb-ref="${ref}"]');
  if (!el) return 'ERR ref ${ref} 不存在，先重新 snapshot';
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed into [' + ${ref} + '] ' + el.tagName.toLowerCase();
})()`

// ---------- 工具 ----------

const TOOLS = [
  {
    name: "browser_tabs",
    description: "列出夸克当前所有标签页（id、标题、URL）。默认工具作用在第一个标签页，可用 target_id 指定。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_open",
    description: "在夸克里新开标签页并导航到 url。",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
  },
  {
    name: "browser_navigate",
    description: "让当前标签页跳转到 url（复用同一个页面）。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, target_id: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description: "读取页面文本快照：URL、标题，以及带 [n] 编号的可交互元素。编号只在本次快照有效，操作前先取。",
    inputSchema: { type: "object", properties: { target_id: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "browser_click",
    description: "点击快照里编号为 ref 的元素（先滚动进视口，再派发 mousedown/mouseup/click）。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "number" },
        target_id: { type: "string" },
        then_snapshot: { type: "boolean", description: "点击后返回新快照，默认 true" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: "往编号为 ref 的输入框填文本（原生 setter，兼容 React 受控组件），并派发 input/change。",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "number" }, text: { type: "string" }, target_id: { type: "string" } },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press",
    description: "在当前页面发一次按键，如 Enter、Tab、Escape、Control+a。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, target_id: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_eval",
    description: "在页面执行一段 JS 并返回结果（JSON 可序列化），用于快照覆盖不到的信息。",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" }, target_id: { type: "string" } },
      required: ["expression"],
      additionalProperties: false,
    },
  },
]

const text = (s) => ({ content: [{ type: "text", text: String(s) }] })
const fail = (s) => ({ content: [{ type: "text", text: String(s) }], isError: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function callTool(name, args = {}) {
  switch (name) {
    case "browser_tabs": {
      const all = await targets()
      if (!all.length) return text("没有打开的标签页")
      return text(all.map((t, i) => `${i + 1}. ${t.title || "(无标题)"}\n   id=${t.id}\n   ${t.url}`).join("\n"))
    }
    case "browser_open": {
      if (!args.url) return fail("缺少 url")
      const all = await targets()
      if (!all.length) {
        const ver = await httpJson("/json/version")
        const bws = new Session(ver.webSocketDebuggerUrl)
        const r = await bws.send("Target.createTarget", { url: args.url })
        bws.close()
        return text(`已新建标签页 id=${r.targetId} → ${args.url}`)
      }
      const { session } = await pickTarget()
      const r = await session.send("Target.createTarget", { url: args.url })
      return text(`已新建标签页 id=${r.targetId} → ${args.url}`)
    }
    case "browser_navigate": {
      if (!args.url) return fail("缺少 url")
      const { session, target } = await pickTarget(args.target_id)
      await session.send("Page.navigate", { url: args.url })
      await sleep(800)
      return text(`已导航：${target.title || ""} → ${args.url}`)
    }
    case "browser_snapshot": {
      const { session } = await pickTarget(args.target_id)
      return text(await session.eval(SNAPSHOT_JS))
    }
    case "browser_click": {
      if (typeof args.ref !== "number") return fail("缺少 ref（数字）")
      const { session } = await pickTarget(args.target_id)
      const res = await session.eval(CLICK_JS(args.ref))
      if (String(res).startsWith("ERR")) return fail(res)
      if (args.then_snapshot === false) return text(res)
      await sleep(700)
      return text(res + "\n\n" + (await session.eval(SNAPSHOT_JS)))
    }
    case "browser_type": {
      if (typeof args.ref !== "number") return fail("缺少 ref（数字）")
      if (typeof args.text !== "string") return fail("缺少 text")
      const { session } = await pickTarget(args.target_id)
      const res = await session.eval(TYPE_JS(args.ref, args.text))
      return String(res).startsWith("ERR") ? fail(res) : text(res)
    }
    case "browser_press": {
      if (!args.key) return fail("缺少 key")
      const { session } = await pickTarget(args.target_id)
      const map = { Enter: 13, Tab: 9, Escape: 27, " ": 32, ArrowDown: 40, ArrowUp: 38, Backspace: 8 }
      const parts = String(args.key).split("+")
      const k = parts[parts.length - 1]
      const mods = /Control/i.test(args.key) ? 2 : /Shift/i.test(args.key) ? 8 : 0
      const vk = map[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0)
      for (const type of ["keyDown", "keyUp"]) {
        await session.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: vk, modifiers: mods })
      }
      return text(`已按键 ${args.key}`)
    }
    case "browser_eval": {
      if (!args.expression) return fail("缺少 expression")
      const { session } = await pickTarget(args.target_id)
      const v = await session.eval(args.expression)
      return text(typeof v === "string" ? v : JSON.stringify(v, null, 2))
    }
    default:
      return fail(`未知工具 ${name}`)
  }
}

// ---------- JSON-RPC ----------

async function handle(msg) {
  const { id, method, params } = msg
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "quark-browser", version: "0.1.0" },
      },
    }
  }
  if (method === "notifications/initialized" || id === undefined) return null
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } }
  if (method === "tools/call") {
    try {
      return { jsonrpc: "2.0", id, result: await callTool(params?.name, params?.arguments || {}) }
    } catch (e) {
      return { jsonrpc: "2.0", id, result: fail(e.message) }
    }
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `未实现的方法 ${method}` } }
}

const argv = process.argv.slice(2)
const httpIdx = argv.indexOf("--http")

if (httpIdx >= 0) {
  const port = Number(argv[httpIdx + 1] || 9311)
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ ok: true, cdp: CDP }))
    }
    if (!req.url.startsWith("/mcp")) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== "POST") {
      res.writeHead(405).end()
      return
    }
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", (c) => (raw += c))
    req.on("end", async () => {
      let payload
      try {
        payload = JSON.parse(raw || "{}")
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } }))
      }
      const out = Array.isArray(payload) ? (await Promise.all(payload.map(handle))).filter(Boolean) : await handle(payload)
      if (out === null) {
        res.writeHead(202).end()
        return
      }
      const body = JSON.stringify(out)
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
      res.end(body)
    })
  })
  server.listen(port, "127.0.0.1", () => {
    console.error(`quark-browser-mcp on http://127.0.0.1:${port}/mcp  (cdp ${CDP})`)
  })
} else {
  let buf = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", async (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.method === undefined) continue
      const out = await handle(msg)
      if (out) process.stdout.write(JSON.stringify(out) + "\n")
    }
  })
  process.stdin.on("end", () => process.exit(0))
}
