#!/usr/bin/env node
/**
 * Replace em and en dashes (banned by the voice rules, section 8.1) in source,
 * tests, scripts and docs.
 *
 *   node scripts/strip-dashes.mjs              report counts per file, change nothing
 *   node scripts/strip-dashes.mjs --write      rewrite the files
 *   node scripts/strip-dashes.mjs --write --include-deferred
 *
 * Deferred paths belong to another worker while branches are open (the oral
 * runtime and the API routes). They are skipped unless --include-deferred is
 * given; run that once after the branches are merged, then run the tests.
 *
 * Rewrites, in order: " dash " becomes ", ", a dash with no spaces between two
 * digits becomes a hyphen, any other dash becomes ", ". HTML entities for the
 * two dashes get the same treatment. The file is ASCII so it contains no dash
 * itself.
 */
import fs from "node:fs";
import path from "node:path";

const AMP = String.fromCharCode(38);
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const write = process.argv.includes("--write");
const includeDeferred = process.argv.includes("--include-deferred");

const ROOTS = ["src", "tests", "scripts", "docs", "design", "README.md", "SECURITY.md", "THIRD-PARTY.md"];
const SKIP = [/design[\\/]audit-fixtures/, /node_modules/, /[\\/]\.next[\\/]/, /docs[\\/]evidence[\\/]/, /scripts[\\/]e2e-golden\.py$/];
const DEFERRED = [/src[\\/]lib[\\/]oral[\\/]/, /src[\\/]app[\\/]api[\\/]/, /tests[\\/]oral-/, /scripts[\\/]probes[\\/]/, /docs[\\/]notes[\\/]/];
const EXT = /\.(ts|tsx|mts|mjs|js|css|md|json|html|svg)$/;

function walk(p, acc = []) {
  if (!fs.existsSync(p)) return acc;
  const st = fs.statSync(p);
  if (st.isFile()) return EXT.test(p) ? (acc.push(p), acc) : acc;
  for (const e of fs.readdirSync(p)) walk(path.join(p, e), acc);
  return acc;
}

function rewrite(text) {
  return text
    .replace(new RegExp(`${AMP}(mdash|#8212);`, "g"), EM)
    .replace(new RegExp(`${AMP}(ndash|#8211);`, "g"), EN)
    .replace(new RegExp(`\\s+[${EM}${EN}]\\s+`, "g"), ", ")
    .replace(new RegExp(`(?<=\\d)${EN}(?=\\d)`, "g"), "-")
    .replace(new RegExp(`\\s*[${EM}${EN}]\\s*`, "g"), ", ");
}

/**
 * A line that matches or splits text on a dash is logic, not prose: rewriting it
 * would change what the code accepts. Those lines are left alone and listed as
 * manual, to be reworded by hand.
 */
const LOGIC = new RegExp(`(\\.replace\\(|\\.split\\(|\\.test\\(|\\.match\\(|toMatch\\(|RegExp|\\[[^\\]]*[${EM}${EN}])`);

function rewriteLines(text, file, manual) {
  return text
    .split(/(\r?\n)/)
    .map((line, i) => {
      if (LOGIC.test(line) && new RegExp(`[${EM}${EN}]`).test(line)) {
        manual.push(`${file}:${Math.floor(i / 2) + 1}`);
        return line;
      }
      return rewrite(line);
    })
    .join("");
}

let total = 0;
const manual = [];
let changedFiles = 0;
let deferred = 0;
for (const f of ROOTS.flatMap((r) => walk(r))) {
  if (SKIP.some((re) => re.test(f))) continue;
  const text = fs.readFileSync(f, "utf8");
  const n = (text.match(new RegExp(`[${EM}${EN}]|${AMP}(mdash|ndash|#8212|#8211);`, "g")) ?? []).length;
  if (!n) continue;
  if (!includeDeferred && DEFERRED.some((re) => re.test(f))) {
    deferred += n;
    console.log(`deferred ${n}\t${f}`);
    continue;
  }
  total += n;
  changedFiles++;
  if (write) fs.writeFileSync(f, rewriteLines(text, f, manual), "utf8");
  else console.log(`${n}\t${f}`);
}
for (const m of manual) console.log(`manual\t${m}`);
console.log(`${write ? "rewrote" : "would rewrite"} ${total} dashes in ${changedFiles} files; deferred ${deferred}`);
