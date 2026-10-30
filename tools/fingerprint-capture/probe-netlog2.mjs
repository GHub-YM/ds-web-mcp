import { spawn } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const netlog = `${process.env.TEMP}\\chrome-netlog2-${Date.now()}.json`;
const profile = `${process.env.TEMP}\\chrome-nlp2-${Date.now()}`;
const port = 9401;

const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--net-log-capture-mode=Everything", `--log-net-log=${netlog}`,
  `--remote-debugging-port=${port}`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3500);

// Drive a real API call to chat.deepseek.com so h2 SEND_HEADERS is recorded.
async function jp(path, method = "GET") { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method }); return r.json(); }
let t;
for (let i = 0; i < 20; i++) { try { t = await jp("/json/new?about:blank", "PUT"); break; } catch { await sleep(500); } }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener("open", r));
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

await send("Page.navigate", { url: "https://chat.deepseek.com/" });
await sleep(12000);
// Force a same-origin POST to the API surface from page context (401 is fine, headers still go out).
await send("Runtime.evaluate", { expression: `fetch('/api/v0/chat_session/create',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status).catch(e=>'err')`, awaitPromise: true });
await sleep(3000);
await send("Browser.close");
await sleep(4000);
try { child.kill(); } catch {}
await sleep(2500);

console.log("netlog size:", existsSync(netlog) ? statSync(netlog).size : "missing");
const text = readFileSync(netlog, "utf8");
// Tolerate a truncated tail.
let parsed = null;
try { parsed = JSON.parse(text); } catch { parsed = JSON.parse(text.slice(0, text.lastIndexOf("}")) + "]}"); }
const events = parsed.events ?? [];
const tn = (t2) => parsed.constants?.logEventTypes?.[t2] ?? String(t2);
console.log("events:", events.length);
const hdrs = events.filter((e) => tn(e.type) === "HTTP2_SESSION_SEND_HEADERS");
console.log("HTTP2_SESSION_SEND_HEADERS:", hdrs.length);
for (const h of hdrs.slice(0, 3)) {
  console.log(`\n=== send_headers stream=${h.params?.stream_id} ===`);
  console.log(JSON.stringify(h.params, null, 1).slice(0, 1500));
}
const set = events.filter((e) => tn(e.type) === "HTTP2_SESSION_SEND_SETTINGS" || tn(e.type) === "HTTP2_SESSION_SEND_WINDOW_UPDATE");
for (const s of set.slice(0, 6)) console.log("\n" + tn(s.type), JSON.stringify(s.params).slice(0, 400));
