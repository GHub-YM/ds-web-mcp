const fs=require("fs"),path=require("path");
const needles=["机器人","robot","Robot","ROBOT","bot","Bot","BOT","automation","headless","User-Agent","user-agent","我是"];
const skip=new Set(["node_modules",".git",".venv"]);
let hits=[];
function walk(d){
  for(const e of fs.readdirSync(d,{withFileTypes:true})){
    if(skip.has(e.name))continue;
    const p=path.join(d,e.name);
    if(e.isDirectory()){walk(p);continue;}
    let buf;try{buf=fs.readFileSync(p);}catch{continue;}
    if(buf.length>4*1024*1024)continue;
    const txt=buf.toString("utf8");
    const lines=txt.split(/\r?\n/);
    lines.forEach((l,i)=>{
      for(const n of needles){ if(l.includes(n)){ hits.push([p,i+1,n,l.trim().slice(0,160)]); break; } }
    });
  }
}
walk(".");
console.log("hits:",hits.length);
for(const h of hits)console.log(`${h[0]}:${h[1]} [${h[2]}] ${h[3]}`);
