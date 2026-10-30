import { createServer } from "node:http";
const s = createServer((req,res)=>{ const h={...req.headers}; console.log(JSON.stringify(h,null,2)); res.writeHead(200); res.end("ok"); });
await new Promise(r=>s.listen(0,"127.0.0.1",r));
const port=s.address().port;
await fetch(`http://127.0.0.1:${port}/api/v0/chat/completion`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
s.close();
