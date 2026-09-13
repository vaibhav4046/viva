import fs from "node:fs";
const { WebSocket } = globalThis;
function env(p){const o={};for(const l of fs.readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<1)continue;o[t.slice(0,i).trim()]=t.slice(i+1).trim().replace(/^["']|["']$/g,"");}return o;}
const KEY = env(".env.local").ASSEMBLYAI_API_KEY;
const TERMS = ["positional encoding","self-attention","softmax","queries keys and values","permutation-equivariant"];

function pcmFrom(path){
  const b = fs.readFileSync(path);
  let off = 12;                       // skip RIFF header
  while (off < b.length - 8) {
    const id = b.toString("ascii", off, off+4), size = b.readUInt32LE(off+4);
    if (id === "data") return b.subarray(off+8, off+8+size);
    off += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

async function token(){
  const r = await fetch("https://streaming.assemblyai.com/v3/token?expires_in_seconds=180",{headers:{Authorization:KEY}});
  return (await r.json()).token;
}

async function run(label, withTerms, pcm){
  const q = new URLSearchParams({ token: await token(), encoding:"pcm_s16le", sample_rate:"16000", format_turns:"true", language_code:"en" });
  if (withTerms) q.set("keyterms_prompt", JSON.stringify(TERMS));
  const ws = new WebSocket("wss://streaming.assemblyai.com/v3/ws?"+q);
  const partials = [];
  let finalText = "";
  await new Promise((resolve, reject) => {
    const bail = setTimeout(()=>{ try{ws.close();}catch{} resolve(); }, 60000);
    ws.onmessage = (ev)=>{
      const m = JSON.parse(String(ev.data));
      if (m.type === "Turn") { if (m.transcript) partials.push(m.transcript); if (m.end_of_turn && m.transcript) finalText = m.transcript; }
      if (m.type === "Termination") { clearTimeout(bail); resolve(); }
      if (m.type === "Error") { clearTimeout(bail); reject(new Error(m.error)); }
    };
    ws.onclose = ()=>{ clearTimeout(bail); resolve(); };
    ws.onerror = ()=>{ clearTimeout(bail); resolve(); };
    ws.onopen = async ()=>{
      const CH = 3200;                       // 100 ms of 16 kHz s16le
      for (let i=0;i<pcm.length;i+=CH){ ws.send(pcm.subarray(i, i+CH)); await new Promise(r=>setTimeout(r,100)); }
      await new Promise(r=>setTimeout(r,2500));
      ws.send(JSON.stringify({ type:"Terminate" }));
    };
  });
  return { label, partials, finalText };
}

const pcm = pcmFrom(".viva/audio/confusion-16k.wav");
console.log("audio:", (pcm.length/32000).toFixed(1)+"s of 16 kHz mono\n");
for (const [label, on] of [["WITHOUT keyterms", false], ["WITH keyterms", true]]) {
  try {
    const r = await run(label, on, pcm);
    console.log(label);
    console.log("  in-flight partials:", r.partials.length);
    const interesting = r.partials.filter(p=>/encod|engag|attention|softmax|equivar/i.test(p));
    for (const p of interesting.slice(-4)) console.log("    …", p.slice(-90));
    console.log("  FINAL:", r.finalText);
    console.log();
  } catch(e){ console.log(label, "FAILED:", e.message); }
  await new Promise(r=>setTimeout(r,4000));
}
