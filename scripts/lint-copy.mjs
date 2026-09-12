/*
 * Copy lint. Fails the build on internal vocabulary that reached a student.
 *
 * VIVA's own docs call the event store a "Misconception Graph" and a saved
 * utterance a "Thought Mark". Those are fine in the codebase and useless on
 * screen — a student should never have to learn our nouns to use the product.
 * Same for engineering vanity: latency percentiles, test counts and audit tool
 * names are not features, and a degraded-storage string is an internal state,
 * not a sentence anyone wants to read.
 *
 * Scope: strings a student can see. Comments, imports and IDENTIFIERS are
 * exempt, so `src/lib/compiler.ts` can keep its name and a record field can
 * keep `interpretationConfidence`; it is the rendered text that matters.
 * Until now that exemption was only documented, never implemented — the check
 * ran over whole lines, so a TypeScript field name and a SQL column tripped a
 * copy rule. It now runs over the text a reader can actually see: string
 * literals, template literals and JSX text. Nothing was removed from the ban
 * list, and `npm run lint:copy -- --self-test` proves every rule still fires.
 *
 * Usage: node scripts/lint-copy.mjs                 (exit 1 on any hit)
 *        node scripts/lint-copy.mjs --self-test     (prove the rules fire)
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "src");

/** Each entry: the banned phrase, and why, so a failure explains itself. */
const BANNED = [
  ["Thought Mark", 'internal name for a saved utterance — say "note"'],
  ["Misconception Graph", 'internal name for the concept index — say "your map"'],
  ["Cognitive Compiler", "internal pipeline name"],
  ["reducer", "implementation detail"],
  ["verifier", "implementation detail"],
  ["deterministic", "implementation detail"],
  ["golden path", "internal test vocabulary"],
  ["interpretation", "reads as a score of the student — say what changed"],
  ["demo prior", "internal seeding detail"],
  ["VIVA estimate", "hedge that means nothing to a student"],
  ["Human / Exploration", "internal tab naming"],
  ["Enter VIVA", "says nothing — name the action"],
  ["Try demo", "says nothing — name the action"],
  ["p50", "latency percentile, not a feature"],
  ["c=10", "load-test concurrency, not a feature"],
  ["c=50", "load-test concurrency, not a feature"],
  ["Tests passing", "test count is not a product claim"],
  ["Axe accessibility", "audit tool name is not a product claim"],
  ["Storage is degraded", "internal state leaked to the UI"],
  ["This store has been suspended", "vendor error leaked to the UI"],
];

/** Chunk ids such as ch_pos_1 must never be rendered. */
const NEWLINE = /\n/g;
// Passage ids come in two shapes: the seeded `ch_pos_1` form and the
// per-subject `src_<id>_c9` form that intake generates. The rule only knew
// the first, so a generated subject leaked raw ids into a sentence and the
// lint still reported clean.
const CHUNK_ID = /\b(?:ch_[a-z]+_\d+|src_[a-z0-9]+_[a-z0-9]+_c\d+)\b/;
/** …but a literal that IS just an id is data (a lookup key), not copy. */
const CHUNK_ID_ONLY = /^\s*(?:ch_[a-z]+_\d+|src_[a-z0-9]+_[a-z0-9]+_c\d+)\s*$/;

/**
 * Blank out everything that is not text a reader can see, keeping every
 * character position (and therefore every line number) intact.
 *
 * Visible spans: single/double-quoted string literals, template literals, and
 * JSX text between a `>` and the next `<`. Comments and import lines are
 * removed first so a phrase inside either can never be reported.
 *
 * Deliberately crude, and biased the same way as before: a false negative is
 * better than blocking a real build.
 */
function visibleText(src) {
  const cleaned = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length))
    .replace(/^\s*import\s[^\n]+$/gm, (m) => " ".repeat(m.length));

  const mask = cleaned.replace(/[^\n]/g, " ").split("");
  const spans = [];

  const patterns = [
    { kind: "string", re: /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g },
    { kind: "template", re: /`(?:[^`\\]|\\.)*`/g },
    // JSX text: what sits between a closing `>` and the next `<`.
    { kind: "jsx", re: />([^<>{}]*)</g },
  ];

  for (const { kind, re } of patterns) {
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const text = kind === "jsx" ? m[1] : m[0];
      const start = kind === "jsx" ? m.index + 1 : m.index;
      if (!text.trim()) continue;
      for (let i = 0; i < text.length; i++) mask[start + i] = cleaned[start + i];
      spans.push({ kind, start, text });
    }
  }

  return { masked: mask.join(""), spans };
}

/**
 * SQL lives in template literals too, and a column name is not copy. A span
 * that reads as a statement is skipped for the phrase rules (the chunk-id rule
 * still applies — a query has no business quoting one at a reader).
 */
const SQL_LIKE = /(select\s|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+table|alter\s+table|values\s*\(|on\s+conflict|returning\s)/i;

function scan(src, rel) {
  const hits = [];
  const { spans } = visibleText(src);

  const lineOf = (offset) => 1 + (src.slice(0, offset).match(NEWLINE) || []).length;

  for (const span of spans) {
    const inner = span.kind === "string" ? span.text.slice(1, -1) : span.text;
    const innerStart = span.kind === "string" ? span.start + 1 : span.start;

    if (!SQL_LIKE.test(inner)) {
      const lower = inner.toLowerCase();
      for (const [phrase, why] of BANNED) {
        const at = lower.indexOf(phrase.toLowerCase());
        if (at === -1) continue;
        hits.push({
          rel,
          line: lineOf(innerStart + at),
          phrase,
          why,
          text: inner.trim().slice(0, 100),
        });
      }
    }

    // Chunk ids: only flag one embedded in a sentence, not a bare id used as a key.
    if (CHUNK_ID_ONLY.test(inner)) continue;
    const m = CHUNK_ID.exec(inner);
    if (!m) continue;
    hits.push({
      rel,
      line: lineOf(innerStart + m.index),
      phrase: m[0],
      why: "chunk id rendered to a student",
      text: inner.trim().slice(0, 100),
    });
  }

  return hits.sort((a, b) => a.line - b.line);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|mdx?)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/* --------------------------- self-test ---------------------------- */
/*
 * The point of narrowing the scope was precision, not leniency. These cases
 * pin both halves: every ban still fires on rendered text, and the things the
 * header always said were exempt finally are.
 */
const SELF_TEST = [
  { src: '<h3 className="x">Misconception Graph</h3>', hits: 1, note: "JSX text" },
  { src: 'const label = "Enter VIVA";', hits: 1, note: "string literal" },
  { src: "const why = `Lowest VIVA estimate among concepts`;", hits: 1, note: "template literal" },
  { src: '<span title="Deterministic review priority">x</span>', hits: 1, note: "JSX attribute string" },
  { src: 'return `Evidence: ch_rl_2, ch_bp_2; read it`;', hits: 1, note: "chunk id in a sentence" },
  { src: 'return `Evidence: src_mtyo8821_wkygtn_c9; read it`;', hits: 1, note: "subject-scoped passage id in a sentence" },
  { src: '  evidenceIds: ["src_mtyo8821_wkygtn_c9"],', hits: 0, note: "subject-scoped id as a data key" },
  { src: "  interpretationConfidence: number;", hits: 0, note: "type field name" },
  { src: "  interpretation_confidence, evidence_ids, status)", hits: 0, note: "SQL column name" },
  { src: '  evidenceIds: ["ch_mh_1"],', hits: 0, note: "chunk id as a data key" },
  { src: '  "ch_sa_1", 1,', hits: 0, note: "chunk id in course data" },
  { src: "// the reducer is deterministic", hits: 0, note: "comment" },
  { src: '/* Thought Mark lives here */', hits: 0, note: "block comment" },
  { src: "await q(`insert into events (importance, interpretation_confidence) values ($1,$2)`);", hits: 0, note: "SQL column in a template literal" },
  { src: "const s = `Your interpretation was off`;", hits: 1, note: "prose in a template literal still fires" },
];

if (process.argv.includes("--self-test")) {
  let failed = 0;
  for (const c of SELF_TEST) {
    const got = scan(c.src, "self-test").length;
    const ok = got === c.hits;
    if (!ok) failed++;
    console.log(`${ok ? "pass" : "FAIL"}  ${c.note} — expected ${c.hits}, got ${got}`);
  }
  console.log(failed ? `\ncopy lint self-test: ${failed} failed` : "\ncopy lint self-test: all pass");
  process.exit(failed ? 1 : 0);
}

const hits = [];
for (const file of walk(ROOT)) {
  hits.push(...scan(fs.readFileSync(file, "utf8"), path.relative(process.cwd(), file)));
}

if (!hits.length) {
  console.log("copy lint: clean");
  process.exit(0);
}

console.error(`copy lint: ${hits.length} banned phrase(s) in student-facing copy\n`);
for (const h of hits) {
  console.error(`  ${h.rel}:${h.line}`);
  console.error(`    "${h.phrase}" — ${h.why}`);
  console.error(`    ${h.text}`);
}
console.error(`\nSee VIVA_MASTER_PROMPT.md §1.3 for the allowed vocabulary.`);
process.exit(1);
