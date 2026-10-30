import net from "node:net";
import http2 from "node:http2";

const NAMES = {0:"DATA",1:"HEADERS",2:"PRIORITY",3:"RST_STREAM",4:"SETTINGS",6:"PING",8:"WINDOW_UPDATE",9:"CONTINUATION"};
const SETTINGS = {1:"HEADER_TABLE_SIZE",2:"ENABLE_PUSH",3:"MAX_CONCURRENT_STREAMS",4:"INITIAL_WINDOW_SIZE",5:"MAX_FRAME_SIZE",6:"MAX_HEADER_LIST_SIZE",8:"ENABLE_CONNECT_PROTOCOL"};
const PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n","ascii");

function parse(buf) {
  const out = []; let off = buf.subarray(0,24).equals(PREFACE) ? 24 : 0;
  while (off + 9 <= buf.length) {
    const len = buf.readUIntBE(off,3), type = buf[off+3], flags = buf[off+4];
    const sid = buf.readUInt32BE(off+5) & 0x7fffffff;
    const p = buf.subarray(off+9, off+9+len);
    let detail = "";
    if (type === 4 && !(flags & 1)) { const a = []; for (let i = 0; i + 6 <= p.length; i += 6) a.push(`${SETTINGS[p.readUInt16BE(i)] ?? "0x"+p.readUInt16BE(i).toString(16)}=${p.readUInt32BE(i+2)}`); detail = a.join(" "); }
    if (type === 8) detail = "delta=" + (p.readUInt32BE(0) & 0x7fffffff);
    if (type === 2) detail = `dep=0x${(p.readUInt32BE(0)&0x7fffffff).toString(16)} excl=${p.readUInt32BE(0)>>>31} w=${p[4]+1}`;
    out.push(`    ${NAMES[type]??type} flags=0x${flags.toString(16)} sid=${sid} len=${len}${detail?" "+detail:""}`);
    off += 9 + len;
  }
  return out;
}

async function capture(label, connectOpts, post) {
  return new Promise(async (resolve) => {
    const srv = net.createServer((sock) => {
      const chunks = []; sock.on("data", (d) => chunks.push(d));
      setTimeout(() => { console.log(`\n### ${label}`); console.log(parse(Buffer.concat(chunks)).join("\n")); sock.destroy(); srv.close(); resolve(); }, 1300);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const c = http2.connect(`http://127.0.0.1:${srv.address().port}`, connectOpts);
    c.on("error", () => {});
    await new Promise((r) => setTimeout(r, 400));
    post?.(c);
  });
}

// Chrome's exact SETTINGS set, in Chrome's order, incl. MAX_FRAME_SIZE
await capture("Chrome-shaped SETTINGS (incl maxFrameSize)", {
  settings: { headerTableSize: 65536, enablePush: false, maxConcurrentStreams: 1000, initialWindowSize: 6291456, maxFrameSize: 16384, maxHeaderListSize: 262144 },
});
await capture("Chrome-shaped + setLocalWindowSize(15663105) then a request", {
  settings: { headerTableSize: 65536, enablePush: false, maxConcurrentStreams: 1000, initialWindowSize: 6291456, maxFrameSize: 16384, maxHeaderListSize: 262144 },
}, (c) => {
  c.setLocalWindowSize(15663105);
  const r = c.request([":method","POST",":authority","x",":scheme","http",":path","/p"]);
  r.on("error", () => {}); r.end("{}");
});
