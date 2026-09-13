/*
 * docs/API-FEEDBACK.md said the Dictation endpoint takes the raw key with no
 * `Bearer` prefix. A prefixed key returned 200, so this checks whether the
 * prefix is tolerated or whether auth is simply not being enforced.
 * Run: node .viva/probe-auth-header.mjs
 */
import fs from "node:fs";
function env(p){const o={};for(const l of fs.readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<1)continue;o[t.slice(0,i).trim()]=t.slice(i+1).trim().replace(/^["']|["']$/g,"");}return o;}
const E = env(".env.local"), KEY = E.ASSEMBLYAI_API_KEY, URL_ = E.ASSEMBLYAI_DICTATION_URL;
function pcmFrom(p){const b=fs.readFileSync(p);let o=12;while(o<b.length-8){const id=b.toString("ascii",o,o+4),s=b.readUInt32LE(o+4);if(id==="data")return b.subarray(o+8,o+8+s);o+=8+s+(s&1);}throw new Error("no data");}
const PCM = pcmFrom(".viva/audio/confusion-16k.wav").subarray(0, 64000); // 2 s is enough to authenticate
async function post(auth){
  const form = new FormData();
  form.append("config", new Blob([JSON.stringify({sample_rate:16000,channels:1,language_codes:["en"]})],{type:"application/json"}), "config.json");
  form.append("audio", new Blob([PCM],{type:"audio/pcm"}), "clip.pcm");
  const headers = auth === null ? {} : { Authorization: auth };
  const r = await fetch(URL_, { method:"POST", headers, body: form });
  return { status: r.status, body: (await r.text()).slice(0,200) };
}
const cases = [
  ["raw key",            KEY],
  ["Bearer <key>",       `Bearer ${KEY}`],
  ["bearer <key> (lc)",  `bearer ${KEY}`],
  ["Bearer <garbage>",   "Bearer notarealkey0000000000000000"],
  ["<garbage>",          "notarealkey0000000000000000"],
  ["no header",          null],
];
for (const [label, auth] of cases) {
  const r = await post(auth);
  const ok = r.status === 200;
  console.log(`  ${label.padEnd(20)} -> ${r.status} ${ok ? "(transcript returned)" : r.body}`);
  await new Promise(r=>setTimeout(r,900));
}
