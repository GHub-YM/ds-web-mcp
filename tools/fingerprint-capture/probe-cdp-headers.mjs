import { spawn } from "node:child_process";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 9333;
const profile = `${process.env.TEMP}\\chrome-cdp-${Date.now()}`;
const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", `--remote-debugging-port=${port}`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3500);

async function json(path) { return (await fetch(`http://127.0.0.1:${port}${path}`)).json(); }
let version;
for (let i = 0; i < 20; i++) { try { version = await json("/json/version"); break; } catch { await sleep(500); } }
console.log("browser:", version?.Browser, "| UA:", version?.["User-Agent"]);

const target = await json("/json/new?https://chat.deepseek.com/");
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method) events.push(msg);
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Network.enable");
await send("Page.enable");
await send("Page.navigate", { url: "https://chat.deepseek.com/" });
await sleep(9000);

const reqs = events.filter((e) => e.method === "Network.requestWillBeSent");
const extra = events.filter((e) => e.method === "Network.requestWillBeSentExtraInfo");

for (const e of reqs) {
  const u = e.params.request.url;
  if (!u.includes("/api/")) continue;
  console.log(`\n=== ${e.params.request.method} ${u} ===`);
  // Extra info carries the wire header set/order.
  const match = extra.find((x) => x.params.requestId === e.params.requestId);
  const hdrs = (match?.params?.headers) ?? e.params.request.headers;
  console.log("ORDER:", JSON.stringify(Object.keys(hdrs)));
  for (const [k, v] of Object.entries(hdrs)) console.log(`  ${k}: ${v}`);
}

console.log("\napiRequests:", reqs.filter((r) => r.params.request.url.includes("/api/")).length);
console.log("totalRequests:", reqs.length);
try { child.kill(); } catch {}
process.exit(0);
