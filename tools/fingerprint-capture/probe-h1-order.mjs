import http from "node:http";

// Does node:http honour an explicit host/connection/content-length and their position?
await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    console.log("h1 RAW ORDER:");
    for (let i = 0; i < req.rawHeaders.length; i += 2) console.log(`  ${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    res.writeHead(200).end("ok"); s.close(); resolve();
  });
  s.listen(0, "127.0.0.1", () => {
    const r = http.request({
      host: "127.0.0.1", port: s.address().port, method: "POST", path: "/api/v0/chat/completion",
      headers: [
        ["Host", `127.0.0.1:${s.address().port}`],
        ["Connection", "keep-alive"],
        ["Content-Length", "2"],
        ["sec-ch-ua-platform", "\"Windows\""],
        ["Authorization", "Bearer T"],
        ["User-Agent", "UA-C"],
        ["x-client-version", "2.5.0"],
        ["sec-ch-ua", "SC"],
        ["content-type", "application/json"],
        ["sec-ch-ua-mobile", "?0"],
        ["Accept", "*/*"],
        ["Origin", "https://chat.deepseek.com"],
        ["Sec-Fetch-Site", "same-origin"],
        ["Sec-Fetch-Mode", "cors"],
        ["Sec-Fetch-Dest", "empty"],
        ["Referer", "https://chat.deepseek.com/"],
        ["Accept-Encoding", "gzip, deflate, br, zstd"],
        ["Accept-Language", "zh-CN,zh;q=0.9"],
        ["priority", "u=1, i"],
        ["Cookie", "a=b"],
      ],
    });
    r.on("error", (e) => { console.log("err", e.message); resolve(); });
    r.end("{}");
  });
});
