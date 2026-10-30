import { createServer } from "node:http";
import { gzipSync, brotliCompressSync, zstdCompressSync } from "node:zlib";

const kinds = ["gzip", "br", "zstd", "identity"];
const s = createServer((req, res) => {
  const started = Date.now();
  const kind = kindOf(req);
  const payload = JSON.stringify({ hello: "world", pad: "x".repeat(500), got: req.headers["accept-encoding"] });
  let body, enc;
  if (kind === "gzip") { body = gzipSync(payload); enc = "gzip"; }
  else if (kind === "br") { body = brotliCompressSync(payload); enc = "br"; }
  else if (kind === "zstd") { body = zstdCompressSync(payload); enc = "zstd"; }
  else { body = Buffer.from(payload); enc = null; }
  const h = { "content-type": "application/json", "content-length": String(body.length) };
  if (enc) h["content-encoding"] = enc;
  res.writeHead(200, h);
  res.end(body);
});
function kindOf(req) { return new URL(req.url, "http://x").pathname.slice(1); }
await new Promise(r => s.listen(0, "127.0.0.1", r));
const port = s.address().port;
for (const k of kinds) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/${k}`, { headers: { "accept-encoding": "gzip, deflate, br, zstd" } });
    const t = await r.text();
    console.log(`${k}: status=${r.status} content-encoding=${r.headers.get("content-encoding")} ok=${t.includes("hello")} len=${t.length}`);
  } catch (e) { console.log(`${k}: FAIL ${e.name}: ${e.message} cause=${e.cause?.message ?? "-"} ${e.cause?.code ?? ""}`); }
}
s.close();
