import fs from "node:fs";
function env(p){const o={};for(const l of fs.readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<1)continue;o[t.slice(0,i).trim()]=t.slice(i+1).trim().replace(/^["']|["']$/g,"");}return o;}
const KEY = env(".env.local").ASSEMBLYAI_API_KEY;
async function token(){
  const r = await fetch("https://streaming.assemblyai.com/v3/token?expires_in_seconds=120", { headers:{ Authorization: KEY }});
  if(!r.ok) throw new Error("token "+r.status+" "+(await r.text()).slice(0,120));
  return (await r.json()).token;
}
const TERMS = ["positional encoding","self-attention","softmax","query key value"];
const variants = [
  { name:"keyterms_prompt json array", build:(t)=>{const q=new URLSearchParams({token:t,encoding:"pcm_s16le",sample_rate:"16000",format_turns:"true",language_code:"en"}); q.set("keyterms_prompt", JSON.stringify(TERMS)); return q; } },
  { name:"keyterms_prompt repeated",    build:(t)=>{const q=new URLSearchParams({token:t,encoding:"pcm_s16le",sample_rate:"16000",format_turns:"true",language_code:"en"}); for(const k of TERMS) q.append("keyterms_prompt",k); return q; } },
  { name:"keyterms_prompt csv",         build:(t)=>{const q=new URLSearchParams({token:t,encoding:"pcm_s16le",sample_rate:"16000",format_turns:"true",language_code:"en"}); q.set("keyterms_prompt", TERMS.join(",")); return q; } },
  { name:"nonsense param (control)",    build:(t)=>{const q=new URLSearchParams({token:t,encoding:"pcm_s16le",sample_rate:"16000",format_turns:"true",language_code:"en"}); q.set("definitely_not_a_param","x"); return q; } },
];
const { WebSocket } = await import("ws").catch(()=>({ WebSocket: globalThis.WebSocket }));
for (const v of variants) {
  let t; try { t = await token(); } catch(e){ console.log(v.name.padEnd(30), "token failed:", e.message); continue; }
  const url = "wss://streaming.assemblyai.com/v3/ws?" + v.build(t);
  const res = await new Promise((resolve)=>{
    const to = setTimeout(()=>{ try{ws.close();}catch{} resolve({r:"timeout"}); }, 12000);
    const ws = new WebSocket(url);
    ws.onopen = () => {};
    ws.onmessage = (ev) => { const m=JSON.parse(String(ev.data)); if(m.type==="Begin"){ clearTimeout(to); resolve({r:"Begin", model:m.configuration?.model, kt: JSON.stringify(m.configuration?.keyterms_prompt ?? m.configuration?.keyterms ?? null).slice(0,120)}); ws.close(); } };
    ws.onclose = (e) => { clearTimeout(to); resolve({ r:"closed", code:e.code, reason:String(e.reason).slice(0,200) }); };
    ws.onerror = () => {};
  });
  console.log(v.name.padEnd(30), JSON.stringify(res));
  await new Promise(r=>setTimeout(r,2500));
}
