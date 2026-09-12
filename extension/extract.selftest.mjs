/*
 * The one runnable check behind extract.js: `node extension/extract.selftest.mjs`.
 *
 * The DOM walking is thin and obvious; the parts that can quietly go wrong are
 * the three pure functions — which container is the article, what counts as a
 * duplicate line, how turns are labelled. Those are what this exercises. It
 * also proves the file still parses and still runs to completion against a
 * page with nothing on it, which is the shape of every failure mode that ends
 * in "the extension did nothing and said nothing".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "extract.js"), "utf8");

// An empty page: the extractor must run to the end and report ok:false.
const emptyDoc = { title: "Nothing", querySelectorAll: () => [], body: null };
const loc = { hostname: "example.com", href: "https://example.com/a#b" };

const load = new Function(
  "document",
  "location",
  `${src.replace(/^\(function \(\) \{/m, "const __run = (function () {").replace(/\}\)\(\);\s*$/, "});")}
   return { tidy, pickBest, joinTurns, run: __run };`
);
const { tidy, pickBest, joinTurns, run } = load(emptyDoc, loc);

const empty = run();
assert.equal(empty.ok, false, "a page with no text is not ok");
assert.equal(empty.url, "https://example.com/a", "the fragment is dropped from the url");
assert.equal(empty.chars, 0);

// tidy: blank runs collapse to one, lines are trimmed, a line repeated
// straight after itself (sticky headers do this) is dropped once.
assert.equal(tidy("  a  \n\n\n\n b \n"), "a\n\nb");
assert.equal(tidy("Menu\nMenu\nreal text"), "Menu\nreal text");
assert.equal(tidy("Menu\nreal\nMenu"), "Menu\nreal\nMenu", "a repeat that is not adjacent stays");
assert.equal(tidy(null), "");

// pickBest: length alone picks the page with the sidebar in it, so a nav-ish
// block loses to prose that is shorter.
const prose = { text: "p".repeat(1000), linkChars: 20 };
const nav = { text: "n".repeat(3000), linkChars: 2900 };
assert.equal(pickBest([nav, prose]), prose, "link density beats raw length");
assert.equal(pickBest([{ text: "short", linkChars: 0 }]), null, "under 200 chars is not an article");
assert.equal(pickBest([]), null);
assert.equal(
  pickBest([{ text: "x".repeat(400), linkChars: 99999 }]),
  null,
  "an all-link block scores zero rather than going negative"
);

// joinTurns: roles become labels, empty turns vanish, order holds.
assert.equal(
  joinTurns([
    { role: "user", text: "what is entropy" },
    { role: "assistant", text: "  " },
    { role: "model", text: "A measure of uncertainty." },
    { role: null, text: "unattributed" },
  ]),
  "Me: what is entropy\n\nAssistant: A measure of uncertainty.\n\nunattributed"
);

console.log("extract.js: 12 checks passed");
