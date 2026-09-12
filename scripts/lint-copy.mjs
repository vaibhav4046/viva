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
 * Scope: strings a student can see. Comments and identifiers are exempt, so
 * `src/lib/compiler.ts` can keep its name; it is the rendered text that
 * matters.
 *
 * Usage: node scripts/lint-copy.mjs   (exit 1 on any hit)
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
  ["interpretation", 'reads as a score of the student — say what changed'],
  ["demo prior", "internal seeding detail"],
  ["VIVA estimate", 'hedge that means nothing to a student'],
  ["Human / Exploration", "internal tab naming"],
  ["Enter VIVA", 'says nothing — name the action'],
  ["Try demo", 'says nothing — name the action'],
  ["p50", "latency percentile, not a feature"],
  ["c=10", "load-test concurrency, not a feature"],
  ["c=50", "load-test concurrency, not a feature"],
  ["Tests passing", "test count is not a product claim"],
  ["Axe accessibility", "audit tool name is not a product claim"],
  ["Storage is degraded", "internal state leaked to the UI"],
  ["This store has been suspended", "vendor error leaked to the UI"],
];

/** Chunk ids such as ch_pos_1 must never be rendered. */
const CHUNK_ID = /\bch_[a-z]+_\d+\b/;

/**
 * Strip things that are not student-facing before matching:
 *  - // line comments and block comments
 *  - JSX comment blocks
 *  - import specifiers
 * Deliberately crude; a false negative is better than blocking a real build.
 */
function stripNonVisible(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/^\s*import\s.+$/gm, " ");
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|mdx?)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const hits = [];
for (const file of walk(ROOT)) {
  const raw = fs.readFileSync(file, "utf8");
  const visible = stripNonVisible(raw);
  const rel = path.relative(process.cwd(), file);

  visible.split(/\r?\n/).forEach((line, i) => {
    for (const [phrase, why] of BANNED) {
      if (line.toLowerCase().includes(phrase.toLowerCase())) {
        hits.push({ rel, line: i + 1, phrase, why, text: line.trim().slice(0, 100) });
      }
    }
    const m = CHUNK_ID.exec(line);
    if (m) {
      hits.push({ rel, line: i + 1, phrase: m[0], why: "chunk id rendered to a student", text: line.trim().slice(0, 100) });
    }
  });
}

if (!hits.length) {
  console.log("copy lint: clean");
  process.exit(0);
}

console.error(`copy lint: ${hits.length} banned phrase(s) in student-facing code\n`);
for (const h of hits) {
  console.error(`  ${h.rel}:${h.line}`);
  console.error(`    "${h.phrase}" — ${h.why}`);
  console.error(`    ${h.text}`);
}
console.error(`\nSee VIVA_MASTER_PROMPT.md §1.3 for the allowed vocabulary.`);
process.exit(1);
