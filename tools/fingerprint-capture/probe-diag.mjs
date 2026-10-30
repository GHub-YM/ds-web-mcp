import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";

const dir = `${process.env.TEMP}\\dswmcp-cert`;
const cert = readFileSync(`${dir}\\cert.pem`);
const key = readFileSync(`${dir}\\key.pem`);
const PORT = 8445;

const srv = http2.createSecureServer({ cert, key, allowHTTP1: false });
srv.on("stream", (stream, headers) => {
  console.log("STREAM:", headers[":method"], headers[":path"], "authority:", headers[":authority"]);
  stream.respond({ ":status": 200, "content-type": "text/html; charset=utf-8" });
  stream.end("<h1>ok</h1>");
});
srv.on("session", (s) => console.log("session established"));
srv.on("error", (e) => console.log("srv error:", e.message));
await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));

// TCP-level listener too, to see if Chrome even attempts the mapped connection.
const tcpSeen = [];
const tcp = net.createServer((sock) => { tcpSeen.push(sock.remoteAddress); console.log("TCP connect from", sock.remoteAddress); sock.destroy(); });
await new Promise((r) => tcp.listen(PORT + 1, "127.0.0.1", r));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = `${process.env.TEMP}\\chrome-diag-${Date.now()}`;
const child = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--ignore-certificate-errors",
  "--no-proxy-server",
  `--host-resolver-rules=MAP chat.deepseek.com 127.0.0.1:${PORT}`,
  "https://chat.deepseek.com/",
], { stdio: ["ignore", "pipe", "pipe"] });
let out = ""; child.stdout.on("data", (d) => out += d); child.stderr.on("data", (d) => out += d);
await new Promise((r) => setTimeout(r, 9000));
console.log("chrome output:", out.trim().slice(0, 800) || "(none)");
try { child.kill(); } catch {}
console.log("tcp connections observed:", tcpSeen.length);
srv.close(); tcp.close();
process.exit(0);
