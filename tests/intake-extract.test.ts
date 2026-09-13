import { describe, expect, it } from "vitest";
import { buildSubject } from "@/lib/intake/build";
import { chunkPages, CHUNK_CHARS, normalizeText } from "@/lib/intake/chunk";
import { extractSubjectBody } from "@/lib/intake/extract";

/**
 * What a student gets when they paste their own notes.
 *
 * A judge pasted 851 words of their own lecture notes on binary search trees.
 * The subject was called "Your notes — your notes", the map it built had
 * concepts called Plain, Correct and Practical difference, and the question
 * it then asked them three times was "Where does Plain come up, and what does
 * it change?". Every passage opened halfway through a clause and every one
 * was stamped with the same locator. Their words: "It has read my notes and
 * produced a vocabulary list from the wrong words."
 *
 * The aliases are the half of this that is not cosmetic. The claim checker
 * matches what a learner says against concept names and aliases, so a bare
 * ordinary word in that list — "cost", "order", "tree", "difference" — is how
 * a correct sentence gets matched to the wrong passage and the student is
 * told they are wrong when they are right. That guard is the strict one here.
 */

const NOTES = `Binary Search Trees and Balancing

A binary search tree stores keys so that every node's left subtree holds keys smaller than the node and every right subtree holds keys larger. That single ordering invariant is what makes lookup cheap: at each node you compare once and throw away half the remaining tree.

The height of the tree is therefore the only thing that matters for performance. Search, insert and delete all walk one root-to-leaf path, so they all cost O(h) where h is the height.

Degenerate insertion order is the classic trap. If you insert 1, 2, 3, 4, 5 into a plain BST in that order, every node becomes the right child of the one before it and the tree collapses into a linked list. The height is now n, and search is now linear.

Checking only that each node is larger than its left child is not enough, because the invariant is about whole subtrees rather than immediate children. The correct validity check passes a min and max range down the recursion, and each node must lie strictly inside the range it inherits.

AVL trees keep the tree short by enforcing a strict balance condition: for every node, the heights of its two subtrees differ by at most one. A single rotation fixes an outside imbalance and a double rotation fixes an inside one. The AVL height bound is about 1.44 log n.

Red-black trees make a looser promise and pay less for it. Every node is coloured red or black, a red node may not have a red child, and every root-to-leaf path contains the same number of black nodes. Those rules bound the height at two log n.

The practical difference is a trade between reads and writes. AVL trees are shorter, so lookups are slightly faster. Red-black trees rebalance more cheaply, so they win when insertions and deletions are frequent.`;

/** The shape of every word the judge was asked to revise and could not. */
const FRAGMENTS = ["plain", "correct", "single", "practical difference", "search"];

function bodyOfNotes() {
  const text = normalizeText(NOTES);
  const chunks = chunkPages([{ text }], "src_test", "Your notes");
  const body = extractSubjectBody(chunks, text);
  expect(body).not.toBeNull();
  return { body: body!, chunks, text };
}

describe("concepts named from a student's own notes", () => {
  it("names the things the notes are about", () => {
    const { body } = bodyOfNotes();
    const names = body.concepts.map((c) => c.name.toLowerCase());
    expect(names.join(" | ")).toMatch(/avl/);
    expect(names.join(" | ")).toMatch(/red-black/);
    expect(names.join(" | ")).toMatch(/ordering invariant/);
  });

  it("never names a concept after a fragment of one sentence", () => {
    const { body } = bodyOfNotes();
    const bad = body.concepts.map((c) => c.name.toLowerCase()).filter((n) => FRAGMENTS.includes(n));
    expect(bad, bad.join(", ")).toEqual([]);
  });

  it("only calls something a concept if the notes say it in those words", () => {
    const { body, text } = bodyOfNotes();
    const haystack = text.toLowerCase().replace(/\s+/g, " ");
    const invented = body.concepts.map((c) => c.name).filter((n) => !haystack.includes(n.toLowerCase()));
    expect(invented, invented.join(", ")).toEqual([]);
  });

  it("keeps bare ordinary words out of the alias list", () => {
    const { body, text } = bodyOfNotes();
    // A term of art is marked as one by the way the student wrote it: an
    // acronym, a symbol, or a hyphenated compound. Anything else has to be a
    // phrase — one word of ordinary English matches far too much.
    const termOfArt = (alias: string) =>
      new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`).test(text) &&
      (/[A-Z]/.test(alias.slice(1)) || /\d/.test(alias) || /[A-Za-z]-[A-Za-z]/.test(alias));
    const loose = body.concepts
      .flatMap((c) => c.aliases)
      .filter((a) => a.trim().split(/\s+/).length === 1 && !termOfArt(a));
    expect(loose, loose.join(", ")).toEqual([]);
  });

  it("gives every question a name a student could answer", () => {
    const { body } = bodyOfNotes();
    for (const q of body.examQuestions) {
      const concept = body.concepts.find((c) => c.id === q.conceptId);
      expect(concept).toBeTruthy();
      expect(q.question).toContain(concept!.name);
    }
  });
});

describe("where a passage starts", () => {
  it("opens each passage on a sentence, not halfway through a clause", () => {
    const text = normalizeText(`${NOTES}\n${NOTES}`);
    const chunks = chunkPages([{ text }], "src_cut", "Your notes");
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_CHARS);
      expect(c.text, c.text.slice(0, 60)).toMatch(/^["'([]?[A-Z0-9]/);
    }
  });
});

describe("what the subject is called", () => {
  it("takes its name from the notes when the route had only a placeholder", async () => {
    const built = await buildSubject({ kind: "paste", title: "Your notes", text: NOTES }, "u_test_title");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.subject.title).toBe("Binary Search Trees and Balancing");
    // "Your notes — your notes" was the whole of what a judge was told their
    // subject was.
    expect(built.subject.sources[0].title).not.toMatch(/notes — your notes/i);
    // And the heading it found is what a citation says, rather than nothing.
    expect(built.subject.sources[0].chunks[0].locator.section).toBe("Binary Search Trees and Balancing");
  });

  it("keeps a title the student actually typed", async () => {
    const built = await buildSubject({ kind: "paste", title: "COMP319 revision", text: NOTES }, "u_test_title2");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.subject.title).toBe("COMP319 revision");
  });
});
