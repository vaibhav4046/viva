/**
 * HTTP-level route tests against a LOCAL dev server (safe endpoints only).
 * Usage: 1) npm run dev -- -p 3111
 *        2) BASE=http://localhost:3111 node scripts/check-routes.mjs
 * Covers status codes, idempotency, scoping, and rate-limit behavior that
 * unit tests cannot reach. Never point at production or metered providers.
 */
const BASE = process.env.BASE ?? "http://localhost:3111";
let cookies = "";

async function call(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (cookies) headers.Cookie = cookies;
  const r = await fetch(BASE + path, { ...opts, headers });
  const set = r.headers.get("set-cookie");
  if (set) {
    const m = set.match(/viva_did=[0-9a-f]{32}/);
    if (m) cookies = m[0];
  }
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body };
}

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`ok: ${name}`);
  else { console.error(`FAIL: ${name} ${extra}`); failures += 1; }
}

// 1. Unknown exam question → 400, never scored as Q1.
{
  const r = await call("/api/exam/answer", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionId: "nope", answer: "order" }),
  });
  check("exam unknown question → 400", r.status === 400, `got ${r.status}`);
}

// 2. Teachback validation → 400 on missing transcript.
{
  const r = await call("/api/teachback/answer", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conceptId: "c_position" }),
  });
  check("teachback missing transcript → 400", r.status === 400, `got ${r.status}`);
}

// 3. Duplicate clientEventId → single event (idempotent retry).
{
  const key = `route-dupe-${Date.now()}`;
  const mk = () => call("/api/events/compile", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: "Remember multi-head attention.", inputKind: "typed", clientEventId: key }),
  });
  const a = await mk();
  const b = await mk();
  check("first compile 200", a.status === 200, `got ${a.status}`);
  check("retry returns duplicate:true, same id", b.status === 200 && b.body.duplicate === true && b.body.event.id === a.body.event.id);
}

// 4. Upload validation codes.
{
  const empty = await call("/api/sources/upload", { method: "POST" });
  check("upload empty → NO_FILE/400-or-413", empty.status === 400 || empty.status === 413, `got ${empty.status}`);
  const form = new FormData();
  form.append("file", new Blob(["%PDF- but truncated"], { type: "application/pdf" }), "x.pdf");
  const bad = await call("/api/sources/upload", { method: "POST", body: form });
  check("upload truncated PDF → 415/422", bad.status === 415 || bad.status === 422, `got ${bad.status} ${JSON.stringify(bad.body?.error)}`);
  const form2 = new FormData();
  form2.append("file", new Blob(["not a pdf"], { type: "text/plain" }), "x.txt");
  const notpdf = await call("/api/sources/upload", { method: "POST", body: form2 });
  check("upload non-PDF → 415", notpdf.status === 415, `got ${notpdf.status}`);
}

// 5. Review shape.
{
  const r = await call("/api/learner/review");
  check("review shape {queue,compound,backend}", r.status === 200 && Array.isArray(r.body.queue) && Array.isArray(r.body.compound) && typeof r.body.backend === "string");
}

// 6. Delete-my-data scoping: delete → history resets to seed only.
{
  await call("/api/events/compile", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: "Remember backprop.", inputKind: "typed", clientEventId: `del-${Date.now()}` }),
  });
  const del = await call("/api/me/data", { method: "DELETE" });
  const after = await call("/api/events");
  check("DELETE wipes to seed-only", del.status === 200 && after.body.count === 1, `count=${after.body?.count}`);
}

// 7. Sustained burst → clean 429s, zero 5xx.
{
  const reqs = Array.from({ length: 70 }, (_, i) => call("/api/events/compile", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: `Burst probe ${i} attention.`, inputKind: "typed", clientEventId: `burst-${Date.now()}-${i}` }),
  }));
  const res = await Promise.all(reqs);
  const byStatus = {};
  for (const r of res) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const bad = res.filter((r) => r.status >= 500).length;
  check("burst: some 429 + zero 5xx", (byStatus[429] ?? 0) > 0 && bad === 0, JSON.stringify(byStatus));
}

if (failures) { console.error(`ROUTE-FAIL: ${failures} checks failed`); process.exit(1); }
console.log("ROUTE-PASS: HTTP route contracts verified");
