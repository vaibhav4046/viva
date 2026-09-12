/**
 * Codified production smoke test — the golden path against a live URL.
 * Usage: BASE=https://viva-vaibhav4046s-projects.vercel.app node scripts/smoke.mjs
 * Fails loudly on any deviation; this is the demo-reliability evidence.
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:3100";

async function get(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`GET ${p} → ${r.status}`);
  return r.json();
}
async function post(p, body) {
  const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${p} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
function assert(cond, msg) {
  if (!cond) { console.error(`SMOKE-FAIL: ${msg}`); process.exit(1); }
  console.log(`ok: ${msg}`);
}

const s = await get("/api/sources");
assert(s.chunks.length === 12, `12 citable chunks (got ${s.chunks.length})`);
assert(s.concepts.length === 6, `6 concepts (got ${s.concepts.length})`);

const l = await get("/api/learner");
assert(Math.abs(l.mastery.c_position.mastery - 0.44) < 1e-9, "seeded c_position mastery 0.44");

const c = await post("/api/events/compile", { transcript: "I don't understand why attention needs positional encoding." });
assert(c.event.intent === "confusion", `intent=confusion (got ${c.event.intent})`);
assert(c.event.primaryConceptId === "c_position", `primary=c_position (got ${c.event.primaryConceptId})`);
assert(c.event.evidenceIds.includes("ch_pos_1") || c.event.evidenceIds.includes("ch_pos_2"), "positional evidence attached");
assert(c.delta === -0.08 && c.reason === "new unresolved confusion", "mastery delta -0.08 with reason");

const q = await post("/api/exam/start", { conceptId: "c_position" });
assert(/positional|order/i.test(q.question), "exam question targets position");

const a = await post("/api/exam/answer", { questionId: "ex_pos_2", answer: "It wouldn't know which words are important." });
assert(a.verdict === "incorrect", `wrong answer flagged (got ${a.verdict})`);
assert(/order/i.test(a.possibleMisconception ?? ""), "misconception names order-vs-importance");

console.log("SMOKE-PASS: golden path verified end to end");
