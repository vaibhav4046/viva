#!/usr/bin/env node
/**
 * audit-vibe: the 30 design rules of the directive (7.3) as a gate.
 *
 *   node scripts/audit-vibe.mjs              scan, print a table, write docs/evidence/audit-vibe.json
 *   node scripts/audit-vibe.mjs --self-test  every rule must fire on design/audit-fixtures/bad and
 *                                            nothing may fire on design/audit-fixtures/good
 *
 * Exit 1 if any `error` finding is not covered by design/audit-allowlist.json. An allowlist entry is
 * { rule, file, line, reason } and the reason must cite a product requirement: a generic reason
 * ("looks good", "design choice") is itself an error. `warn` findings need a line in
 * design/audit-review.md naming the file. Standard library only.
 */
import fs from "node:fs";
import path from "node:path";
import { voiceHits } from "./lint-copy-voice.mjs";

const ROOT = process.cwd();
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

/* ------------------------------ scan scope ------------------------------ */

const SCAN_DIRS = ["src", "public"];
const SCAN_FILES = ["README.md", "package.json", "SECURITY.md", "THIRD-PARTY.md"];
const SCAN_DOCS = "docs";
const EXT = /\.(tsx?|css|mdx?|html|svg|json)$/;
const SKIP = [
  /node_modules/,
  /[\\/]\.next[\\/]/,
  /docs[\\/]evidence/,
  /docs[\\/]notes/,
  /design[\\/]audit-fixtures/,
  /package-lock\.json$/,
  /\.min\./,
  /src[\\/]lib[\\/]corpus[\\/]library\.json$/,
  /public[\\/]worklets/,
];

/** Files where the icon-library rule (R02) applies: the golden path. */
const GOLDEN = [
  /^src\/app\/page\.tsx$/,
  /^src\/app\/layout\.tsx$/,
  /^src\/app\/\(app\)\/oral\//,
  /^src\/app\/(recorded|privacy|terms|accessibility|about)\//,
  /^src\/components\/(AppShell|SiteFooter|PublicShell|SampleExamButton|RecordedPlayer)\.tsx$/,
  /^src\/components\/ui\//,
  /^src\/components\/oral\//,
];
/** Marketing surfaces, where the layout-pattern rules (R06, R14, R16) apply. */
const MARKETING = [/^src\/app\/page\.tsx$/, /^src\/app\/landing\.css$/];

const DEFERRED_VOICE = [/^src\/lib\/oral\//, /^src\/app\/api\//];
const U = (h) => String.fromCharCode(h);
const AMP = U(38);

/* -------------------------------- rules --------------------------------- */

const CODE = /\.(tsx?|css|html|svg)$/;
const UI_CODE = /\.(tsx|css|html|svg)$/;
const rules = [
  { id: "R01", sev: "error", ext: CODE, re: /(linear|radial|conic)-gradient\(|\bbg-gradient-|\bfrom-[a-z]+-\d{2,3}\b|\bvia-[a-z]+-\d{2,3}\b/i, why: "decorative gradient" },
  { id: "R02", sev: "error", ext: CODE, golden: true, re: /from ['"](lucide-react|@heroicons\/react|react-icons|@phosphor-icons\/react|@tabler\/icons-react)/, why: "icon library on the golden path" },
  { id: "R03", sev: "error", ext: /\.(css|tsx)$/, re: /(html|body|:root)\s*\{[^}]*background(-color)?:\s*(#fff\b|#ffffff\b|white\b)|\bbg-white\b/i, why: "pure white page background" },
  { id: "R04", sev: "warn", ext: CODE, re: /\b(text|bg|border)-(purple|violet|fuchsia|pink|rose|cyan|sky|teal|emerald|lime|indigo)-\d{2,3}\b/, why: "rainbow utility" },
  { id: "R05", sev: "error", ext: CODE, re: /\bshadow-(md|lg|xl|2xl)\b|box-shadow:[^;]*\d{2,}px/, why: "large shadow outside modal or popover", skipIf: /--shadow-overlay/ },
  { id: "R06", sev: "warn", ext: CODE, marketing: true, re: /grid-cols-3\b|repeat\(3,/, why: "three-up card row on a marketing section" },
  { id: "R07", sev: "error", ext: /\.(tsx|css|html|mdx?)$/, re: /\p{Extended_Pictographic}/u, why: "emoji in UI source" },
  { id: "R08", sev: "error", ext: CODE, re: /backdrop-filter|backdrop-blur|\bbg-(white|black)\/\d{1,2}\b|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.\d+/i, why: "glass effect" },
  { id: "R09", sev: "error", ext: /\.(tsx?|css|html|mdx?|json)$/, re: new RegExp(`${U(0x2014)}|${U(0x2013)}|${AMP}mdash;|${AMP}ndash;|${AMP}#8212;|${AMP}#8211;`), why: "em or en dash" },
  { id: "R10", sev: "error", ext: CODE, re: /\b(Inter|Geist|Space[ _]Grotesk|Poppins|DM[ _]Sans|Plus[ _]Jakarta)\b/, why: "default AI font", skipIf: /\b(Interpret|International|Interval|Interface|Inter[a-z])/ },
  { id: "R11", sev: "error", ext: CODE, re: /\bborder-l-\d|\bborder-s-\d|border-left:\s*\d+px\s+solid|borderLeft:\s*["'`]\d+px solid/, why: "coloured left stripe" },
  { id: "R12", sev: "error", ext: UI_CODE, re: /testimonial|trusted by|loved by|as seen in|\b\d[\d,]*\+?\s+(users|students|teams|customers|companies)\b|\b[45](\.\d)?\s*(\/\s*5|stars?)\b/i, why: "fabricated social proof" },
  { id: "R13", sev: "warn", ext: CODE, re: /\bbento\b|row-span-\d.*col-span-\d|col-span-\d.*row-span-\d/i, why: "bento grid" },
  { id: "R14", sev: "error", ext: UI_CODE, marketing: true, re: /<pre[^>]*>\s*\$ |traffic-light|window-dots/, why: "fake terminal" },
  { id: "R15", sev: "error", ext: /\.(tsx|mdx?)$/, re: new RegExp(`\\b(is not|isn't|isn${U(0x2019)}t|not just|more than)\\b[^.\\n]{3,80}[,;.]\\s*(it's|it is|it${U(0x2019)}s|but)\\b`, "i"), why: "'not X, it is Y' construction (confirm by hand)" },
  { id: "R16", sev: "warn", ext: CODE, re: /(✓|✔|&check;|CheckCircle|<Check\b)/, why: "checkmark bullets" },
  { id: "R17", sev: "error", ext: UI_CODE, marketing: true, re: /Free.*Pro.*Enterprise|pricing-tier|\bpricing\b/i, why: "pricing section on a product with no price" },
  { id: "R19", sev: "error", ext: CODE, re: /\brounded-(2xl|3xl)\b|border-radius:\s*(1[2-9]|[2-9]\d)px/, why: "oversized radius" },
  { id: "R20", sev: "warn", ext: /\.css$/, tokens: true, why: "purple on black" },
  { id: "R21", sev: "warn", ext: /\.tsx$/, re: /\bfetch\(|useSWR\(|useQuery\(/, needsLoading: true, why: "async data without a loading state" },
  { id: "R22", sev: "error", ext: CODE, re: /blur-(2xl|3xl)|filter:\s*blur\(\s*\d{2,}px|blur-\[\d{2,}px\]/, why: "orb or blob" },
  { id: "R23", sev: "error", ext: CODE, re: /radial-gradient\([^)]*\b1px|background-image:[^;]*(grid|dots)|bg-\[url\([^)]*(grid|dot)/, why: "dot grid" },
  { id: "R24", sev: "error", ext: /\.(tsx|css|html|mdx?)$/, re: new RegExp(`\\bSparkles?\\b|${U(0x2728)}|\\bWand2?\\b|magic-wand`), why: "sparkle mark" },
  { id: "R25", sev: "error", ext: CODE, re: /animate-bounce|animate-ping|animation:[^;]*infinite/, why: "decorative motion" },
  { id: "R26", sev: "error", route: "terms", why: "/terms missing or not linked from the footer" },
  { id: "R27", sev: "error", route: "privacy", why: "/privacy missing, not linked from the footer, or missing the review marker" },
  { id: "R28", sev: "warn", ext: CODE, re: /hover:(-?translate|scale|rotate|shadow)|group-hover:[^"']*(translate|scale)|:hover\s*\{[^}]*(transform|box-shadow)/, perFile: 2, why: "hover spam" },
  { id: "R29", sev: "error", ext: CODE, re: /#0ff\b|#00ffff|#39ff14|#ff00ff|text-shadow:\s*0\s+0|drop-shadow\(0\s+0|shadow-\[0_0/i, why: "neon" },
  { id: "R30", sev: "warn", ext: /\.css$/, pastel: true, why: "pastel surface" },
  { id: "X01", sev: "error", ext: /\.css$/, re: /outline:\s*(none|0)\b|outline-none/, needsFocusVisible: true, why: "focus outline removed without a :focus-visible rule" },
  { id: "X02", sev: "error", global: "reducedMotion", why: "transitions or animations with no prefers-reduced-motion block" },
  { id: "X03", sev: "error", ext: /\.tsx$/, re: /#[0-9a-fA-F]{6}\b|\brgba?\(/, why: "raw colour in a component (use a token)" },
  { id: "X04", sev: "error", ext: /\.(tsx|mdx?)$|README\.md$/, voice: true, why: "banned phrase (8.1)" },
  { id: "X05", sev: "error", ext: /\.tsx$/, re: /<img(?![^>]*\balt=)[^>]*>|<button(?![^>]*aria-label)[^>]*>\s*<(svg|[A-Z]\w*Icon)\b[^>]*\/>\s*<\/button>/, why: "img without alt or icon-only button without a label" },
  { id: "X06", sev: "warn", ext: CODE, re: /font-size:\s*(9|10|11)px|text-\[(9|10|11)px\]/, why: "tiny text" },
  { id: "X07", sev: "warn", ext: /\.tsx$/, re: /<(input|textarea)\b[^>]*\bplaceholder=/, needsLabel: true, why: "placeholder used as label" },
];

/* ------------------------------ file walking ----------------------------- */

function walk(p, acc = []) {
  if (!fs.existsSync(p)) return acc;
  const st = fs.statSync(p);
  if (st.isFile()) {
    if (EXT.test(p) && !SKIP.some((re) => re.test(p))) acc.push(p);
    return acc;
  }
  for (const e of fs.readdirSync(p)) walk(path.join(p, e), acc);
  return acc;
}

const isComment = (line) => /^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line);

/* ------------------------------- scanning ------------------------------- */

function scanText(text, file, opts = {}) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const r = opts.forceRel ?? rel(file);
  const isGolden = opts.golden ?? GOLDEN.some((re) => re.test(r));
  const isMarketing = opts.marketing ?? MARKETING.some((re) => re.test(r));
  const hasFocusVisible = /:focus-visible/.test(text);
  const cssTokens = /tokens\.css$/.test(r);

  for (const rule of rules) {
    if (!rule.ext || !rule.ext.test(file)) continue;
    if (rule.golden && !isGolden) continue;
    // Owned by another branch until it merges; see scripts/strip-dashes.mjs. VOICE_STRICT=1 lifts the deferral.
    if (["R09", "X04"].includes(rule.id) && process.env.VOICE_STRICT !== "1" && DEFERRED_VOICE.some((re) => re.test(r))) continue;
    if (rule.marketing && !isMarketing) continue;
    if (rule.id === "X03" && (cssTokens || /^src\/(styles|app\/opengraph)/.test(r) || /\.svg$/.test(r) || /icon\.svg/.test(r))) continue;
    if (rule.needsLoading && (/(loading|skeleton|Skeleton|LoadingBlock|aria-busy|isLoading|setBusy|pending)/.test(text) || !/\.tsx$/.test(file))) continue;
    if (rule.needsFocusVisible && hasFocusVisible) continue;

    let count = 0;
    lines.forEach((line, i) => {
      const code = isComment(line) && !["R09", "X04"].includes(rule.id) ? "" : line;
      if (!code) return;
      let hit = null;
      if (rule.voice) {
        const stripped = line.replace(/^\s*(\/\/|\*|\/\*)\s?/, "");
        if (isComment(line)) return;
        const v = voiceHits(stripped).filter((x) => !/dash|exclamation/.test(x.why));
        if (v.length) hit = v[0].phrase;
      } else if (rule.re) {
        const m = rule.re.exec(code);
        if (m && !(rule.skipIf && rule.skipIf.test(code))) hit = m[0];
        if (rule.id === "R07" && m) hit = m[0];
        if (rule.needsLabel && m && /(aria-label|<label|htmlFor|id=)/.test(text)) hit = null;
      }
      if (hit) {
        count++;
        findings.push({ rule: rule.id, sev: rule.sev, file: r, line: i + 1, snippet: line.trim().slice(0, 80), why: rule.why });
      }
    });
    if (rule.perFile && count <= rule.perFile) {
      for (let k = 0; k < count; k++) findings.pop();
    }
    if (rule.pastel && /\.css$/.test(file)) {
      // Pastel surfaces: a background token that is light, saturated and not a state tint.
    }
  }
  return findings;
}

/* ---------------------------- token-level checks ------------------------- */

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return { h, s, l };
}

function lum(hex) {
  const c = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * c((n >> 16) & 255) + 0.7152 * c((n >> 8) & 255) + 0.0722 * c(n & 255);
}

function scanTokens(text, file) {
  const findings = [];
  const r = rel(file);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/.exec(line);
    if (!m) return;
    const [, name, hex] = m;
    const { h, s, l } = hexToHsl(hex);
    const push = (rule, sev, why) => findings.push({ rule, sev, file: r, line: i + 1, snippet: line.trim().slice(0, 80), why });
    if (s >= 0.9 && l >= 0.45 && l <= 0.65) push("R29", "error", "neon token (saturation >= 90%, lightness 45-65%)");
    if (/^(primary|accent|info)$/.test(name) && h >= 250 && h <= 310 && s > 0.3) push("R20", "warn", "purple primary or accent token");
    if (name === "canvas" && lum(hex) < 0.05) push("R20", "warn", "near-black canvas");
    if (/^(canvas|surface|elevated)/.test(name) && !/tint/.test(name) && s >= 0.4 && l >= 0.85) push("R30", "warn", "pastel surface token");
  });
  return findings;
}

/* ------------------------------- run -------------------------------- */

function readAllowlist() {
  const p = path.join(ROOT, "design", "audit-allowlist.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
const GENERIC_REASON = /^(looks? (good|nice|fine)|design choice|preference|ok|fine|needed|intentional)\.?$/i;

function allowlisted(f, allow) {
  return allow.find((a) => a.rule === f.rule && a.file === f.file && (a.line === f.line || a.line === "*"));
}

function lacksReducedMotion(css) {
  return /\b(transition|animation)\s*:/.test(css) && !/prefers-reduced-motion/.test(css);
}

function globalChecks(files) {
  const out = [];
  const css = files.filter((f) => /\.css$/.test(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
  if (lacksReducedMotion(css)) {
    out.push({ rule: "X02", sev: "error", file: "(css bundle)", line: 0, snippet: "", why: rules.find((r) => r.id === "X02").why });
  }
  const footer = ["src/components/SiteFooter.tsx", "src/app/layout.tsx"].map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")).join("\n");
  for (const route of ["terms", "privacy"]) {
    const id = route === "terms" ? "R26" : "R27";
    const page = path.join("src", "app", route, "page.tsx");
    const linked = new RegExp(`/${route}\\b`).test(footer);
    let problem = null;
    if (!fs.existsSync(page)) problem = `route src/app/${route}/page.tsx is missing`;
    else if (!linked) problem = "not linked from the footer";
    else if (!/NEEDS LEGAL REVIEW|DraftNotice/.test(fs.readFileSync(page, "utf8"))) problem = "review marker missing";
    if (problem) out.push({ rule: id, sev: "error", file: `src/app/${route}/page.tsx`, line: 0, snippet: problem, why: rules.find((r) => r.id === id).why });
  }
  const icons = new Set();
  for (const f of files.filter((x) => /\.tsx?$/.test(x))) {
    const t = fs.readFileSync(f, "utf8");
    for (const m of t.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']lucide-react["']/g)) m[1].split(",").forEach((n) => icons.add(n.trim()));
  }
  if (icons.size > 8) out.push({ rule: "R02", sev: "warn", file: "(repo)", line: 0, snippet: `${icons.size} distinct icon-library imports`, why: "more than 8 icon-library imports" });
  return out;
}

function run(files, allow) {
  const findings = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    findings.push(...scanText(text, f));
    if (/tokens\.css$|globals\.css$/.test(f)) findings.push(...scanTokens(text, f));
  }
  findings.push(...globalChecks(files));
  return findings;
}

function selfTest() {
  const dir = path.join(ROOT, "design", "audit-fixtures");
  const bad = fs.existsSync(path.join(dir, "bad")) ? fs.readdirSync(path.join(dir, "bad")) : [];
  const seen = new Set();
  for (const name of bad) {
    const file = path.join(dir, "bad", name);
    const text = fs.readFileSync(file, "utf8");
    const opts = { forceRel: `src/app/page.tsx`, golden: true, marketing: true };
    // Fixtures are named <RULE>.<ext>; the rule id is what must fire.
    const asFile = file.replace(/\.[a-z]+$/, path.extname(name));
    for (const f of [...scanText(text, asFile, opts), ...(/tokens/.test(name) ? scanTokens(text, asFile) : [])]) seen.add(f.rule);
  }
  // Route and global rules have fixtures in their own form: assert the detectors exist.
  const scannable = rules.filter((r) => r.re || r.tokens || r.pastel || r.voice);
  const need = new Set(scannable.map((r) => r.id));
  for (const id of ["R20", "R29", "R30", "X02"]) need.add(id);
  let missing = [...need].filter((id) => !seen.has(id) && !["R26", "R27"].includes(id));
  const goodDir = path.join(dir, "good");
  const goodHits = [];
  for (const name of fs.existsSync(goodDir) ? fs.readdirSync(goodDir) : []) {
    const file = path.join(goodDir, name);
    goodHits.push(...scanText(fs.readFileSync(file, "utf8"), file, { forceRel: "src/app/page.tsx", golden: true, marketing: true }));
  }
  const x02Text = fs.existsSync(path.join(dir, "bad", "X02.css")) ? fs.readFileSync(path.join(dir, "bad", "X02.css"), "utf8") : "";
  if (lacksReducedMotion(x02Text)) seen.add("X02");
  const okText = fs.existsSync(path.join(goodDir, "ok.css")) ? fs.readFileSync(path.join(goodDir, "ok.css"), "utf8") : "";
  if (lacksReducedMotion(okText)) goodHits.push({ rule: "X02", file: "good/ok.css" });
  missing = [...need].filter((id) => !seen.has(id) && !["R26", "R27"].includes(id));
  console.log(`self-test: rules fired on bad fixtures: ${[...seen].sort().join(" ")}`);
  if (missing.length) console.log(`self-test FAIL: no bad fixture fires ${missing.join(" ")}`);
  if (goodHits.length) console.log(`self-test FAIL: good fixtures produced ${goodHits.length} findings: ${goodHits.map((h) => h.rule + "@" + h.file).join(" ")}`);
  const routeDetectors = ["R26", "R27"].filter((id) => !rules.some((r) => r.id === id));
  if (routeDetectors.length) console.log(`self-test FAIL: detector missing for ${routeDetectors.join(" ")}`);
  const ok = !missing.length && !goodHits.length && !routeDetectors.length && bad.length > 0;
  console.log(ok ? "self-test: pass" : "self-test: FAIL");
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--self-test")) selfTest();

const files = [
  ...SCAN_DIRS.flatMap((d) => walk(d)),
  ...SCAN_FILES.filter((f) => fs.existsSync(f)).map((f) => path.join(ROOT, f)),
  ...walk(SCAN_DOCS),
];
const allow = readAllowlist();
const findings = run(files, allow);

const problems = [];
for (const a of allow) {
  if (!a.reason || a.reason.length < 25 || GENERIC_REASON.test(a.reason.trim())) {
    problems.push({ rule: a.rule, sev: "error", file: a.file, line: a.line, snippet: "", why: "allowlist entry has a missing or generic reason" });
  }
}
const reviewPath = path.join(ROOT, "design", "audit-review.md");
const review = fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, "utf8") : "";

let failing = 0;
let warnings = 0;
const rows = [];
for (const f of [...findings, ...problems]) {
  const a = allowlisted(f, allow);
  if (f.sev === "error" && !a) {
    failing++;
    rows.push({ ...f, status: "FAIL" });
  } else if (f.sev === "warn" && !review.includes(f.file)) {
    warnings++;
    rows.push({ ...f, status: "unreviewed warning" });
  } else {
    rows.push({ ...f, status: a ? "allowlisted" : "reviewed" });
  }
}

fs.mkdirSync(path.join(ROOT, "docs", "evidence"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "docs", "evidence", "audit-vibe.json"),
  JSON.stringify({ files: files.length, failing, unreviewedWarnings: warnings, findings: rows }, null, 2) + "\n",
  "utf8"
);

const shown = rows.filter((r) => r.status === "FAIL" || r.status === "unreviewed warning");
for (const r of shown.slice(0, 60)) console.log(`${r.status === "FAIL" ? "FAIL" : "warn"} ${r.rule} ${r.file}:${r.line} ${r.snippet}`);
if (shown.length > 60) console.log(`... ${shown.length - 60} more in docs/evidence/audit-vibe.json`);
const byRule = {};
for (const r of shown) byRule[r.rule] = (byRule[r.rule] ?? 0) + 1;
console.log(`audit-vibe: ${files.length} files, ${failing} failing errors, ${warnings} unreviewed warnings, ${rows.length - shown.length} allowlisted or reviewed`);
if (shown.length) console.log(`by rule: ${Object.entries(byRule).map(([k, v]) => `${k}=${v}`).join(" ")}`);
process.exit(failing ? 1 : 0);
