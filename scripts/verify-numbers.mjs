#!/usr/bin/env node
/**
 * Every entry in numbers.json must have n, date, cmd and an evidence file that exists and contains the
 * value. Only numbers listed there may appear in public copy.
 *
 *   node scripts/verify-numbers.mjs
 */
import fs from "node:fs";

const numbers = JSON.parse(fs.readFileSync("numbers.json", "utf8"));
let failed = 0;
for (const [key, e] of Object.entries(numbers)) {
  const problems = [];
  for (const f of ["value", "n", "date", "evidence", "cmd"]) if (e[f] === undefined) problems.push(`missing ${f}`);
  if (e.evidence && !fs.existsSync(e.evidence)) problems.push(`evidence file ${e.evidence} not found`);
  else if (e.evidence && !fs.readFileSync(e.evidence, "utf8").includes(String(e.value))) problems.push(`value ${e.value} not in ${e.evidence}`);
  if (problems.length) {
    failed++;
    console.log(`FAIL ${key}: ${problems.join("; ")}`);
  }
}
console.log(`verify-numbers: ${Object.keys(numbers).length} numbers, ${failed} failing`);
process.exit(failed ? 1 : 0);
