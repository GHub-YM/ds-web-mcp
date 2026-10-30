import http2 from "node:http2";
import net from "node:net";

const srv = http2.createServer();
srv.on("stream", (stream, headers) => {
  console.log("SERVER header order:", JSON.stringify(Object.keys(headers)));
  stream.respond({ ":status": 200, "content-type": "text/plain" });
  stream.end("ok");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

const session = http2.connect(`http://127.0.0.1:${port}`, {
  settings: { headerTableSize: 65536, enablePush: false, maxConcurrentStreams: 1000, initialWindowSize: 6291456, maxHeaderListSize: 262144 },
});
console.log("session type:", typeof session, session?.constructor?.name);
console.log("has setLocalWindowSize:", typeof session.setLocalWindowSize);
console.log("has setNextStreamID:", typeof session.setNextStreamID);
try { session.setLocalWindowSize(15663105); console.log("setLocalWindowSize ok"); } catch (e) { console.log("setLocalWindowSize ERR:", e.message); }

const req = session.request({
  ":method": "POST",
  ":path": "/api/v0/chat/completion",
  "sec-ch-ua": "\"Chromium\";v=\"153\"",
  "user-agent": "UA-TEST",
  "content-type": "application/json",
});
console.log("client sentHeaders order:", JSON.stringify(Object.keys(req.sentHeaders ?? {})));
req.on("response", (h) => console.log("client got status", h[":status"]));
req.end("{}");
await new Promise((r) => req.on("end", r).on("close", r).on("error", r));
session.close();
srv.close();
