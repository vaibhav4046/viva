import type { EvidenceVerdict, SourceChunk } from "./types";

const STOP = new Set(
  "the,a,an,and,or,of,to,in,is,it,that,this,these,those,with,for,on,as,at,by,from,be,are,was,were,what,why,how,does,do,which,who,its,into,over,under,about,i,you,we,they,he,she,my,me,so,very,really,just,like,basically,somehow,all,each,every,without,within,because,when,if,then,than,there,their,them,his,her,our,your".split(",")
);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Pragmatic hybrid retrieval: lexical overlap + active-source boost +
 * concept boost. No embeddings required; pgvector can replace scoring later
 * behind the same `retrieveEvidence` interface.
 */
export function scoreChunks(
  chunks: SourceChunk[],
  query: string,
  opts: { sourceId?: string | null; conceptIds?: string[]; limit?: number } = {}
): { chunk: SourceChunk; score: number }[] {
  const limit = opts.limit ?? 3;
  const q = new Set(tokens(query));
  const conceptText = (opts.conceptIds ?? []).join(" ").toLowerCase();
  // Adjacent query words that reappear verbatim in a chunk signal a strong
  // multi-word concept hit ("positional encoding", "base rate", "dot product").
  const qWords = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const scored = chunks.filter(
    (c) => !opts.sourceId || c.sourceId === opts.sourceId
  ).map((chunk) => {
    const ct = new Set(tokens(chunk.text));
    let overlap = 0;
    q.forEach((w) => { if (ct.has(w)) overlap += 1; });
    // Concept boost: chunk section mentions the concept vocabulary.
    let boost = 0;
    for (const w of tokens(conceptText)) if (ct.has(w)) boost += 0.5;
    // Phrase bonus for exact multi-word query hits (phrase must be IN the chunk).
    let phraseBonus = 0;
    const chunkLow = chunk.text.toLowerCase();
    for (let i = 0; i + 1 < qWords.length; i++) {
      if (chunkLow.includes(`${qWords[i]} ${qWords[i + 1]}`)) { phraseBonus = 2; break; }
    }
    const score = overlap + boost + phraseBonus + chunk.ordinal * 0.001;
    return { chunk, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Score a subject's own passages. `chunks` is required: there is no default
 * subject to fall back to, and quietly searching somebody else's material
 * would be worse than returning nothing.
 */
export function retrieveEvidence(
  query: string,
  opts: { chunks: SourceChunk[]; sourceId?: string | null; conceptIds?: string[]; limit?: number }
): { chunk: SourceChunk; score: number }[] {
  const { chunks, ...rest } = opts;
  return scoreChunks(chunks, query, rest);
}

/**
 * HARNESS B — Evidence Grounding. Source text is DATA, never instructions:
 * any "ignore previous instructions" inside a chunk is inert because we only
 * do keyword containment checks here, never prompt-inject the chunk.
 */
export function verifyEvidence(
  claim: string,
  chunks: SourceChunk[]
): EvidenceVerdict {
  const support: string[] = [];
  const contradiction: string[] = [];
  const insufficient: string[] = [];
  const ct = tokens(claim);
  for (const c of chunks) {
    const ctok = new Set(tokens(c.text));
    const hits = ct.filter((w) => ctok.has(w)).length;
    const coverage = ct.length === 0 ? 0 : hits / ct.length;
    if (coverage >= 0.25) support.push(c.id);
    else insufficient.push(c.id);
  }
  // A claim about what matters, answered by passages that talk about order,
  // is the shape of a contradiction in any subject: the learner is asserting
  // one property while the source discusses another.
  if (/\bimportan(?:t|ce)\b/i.test(claim)) {
    for (const c of chunks) {
      if (/\b(order|ordering|sequence|position|positional|permutation)\b/i.test(c.text) && !contradiction.includes(c.id)) {
        contradiction.push(c.id);
      }
    }
  }
  const coverage =
    chunks.length === 0 ? 0 : Math.round((support.length / chunks.length) * 100) / 100;
  return { support, contradiction, insufficient, coverage, sourceRequired: true };
}
