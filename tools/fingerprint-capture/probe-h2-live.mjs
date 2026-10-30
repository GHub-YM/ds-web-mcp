import http2 from "node:http2";
import tls from "node:tls";

// 1) Real ALPN negotiation against the target.
const negotiated = await new Promise((resolve) => {
  const s = tls.connect({ host: "chat.deepseek.com", port: 443, ALPNProtocols: ["h2", "http/1.1"], servername: "chat.deepseek.com" }, () => resolve({ alpn: s.alpnProtocol, cipher: s.getCipher(), proto: s.getProtocol(), auth: s.getPeerCertificate()?.subject?.CN }));
  s.on("error", (e) => resolve({ error: e.message }));
  setTimeout(() => resolve({ error: "timeout" }), 15000);
});
console.log("ALPN negotiation:", JSON.stringify(negotiated));

// 2) Real h2 connection: capture the server SETTINGS frame + a GET.
const client = http2.connect("https://chat.deepseek.com");
client.on("remoteSettings", (s) => console.log("SERVER SETTINGS:", JSON.stringify(s)));
client.on("error", (e) => console.log("h2 error:", e.message));
const req = client.request({ ":method": "HEAD", ":path": "/" });
req.on("response", (h) => console.log("HEAD response:", JSON.stringify(h)));
req.on("error", (e) => console.log("HEAD error:", e.message));
req.on("close", () => client.close());
req.end();
setTimeout(() => { try { client.destroy(); } catch {} }, 15000);
