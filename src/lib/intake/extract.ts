import type { ConceptDef, ExamQuestion, Explainer } from "@/lib/courses/types";
import type { SourceChunk } from "@/lib/types";

/**
 * Reading the notes without a model.
 *
 * When no language model is reachable, VIVA still has to produce a subject a
 * student can actually study: the concepts, the questions and the passages
 * they came from. Everything below is pulled out of the learner's own text —
 * the headings they wrote, the sentences that define something, the phrases
 * they keep coming back to. Nothing is invented: every description and every
 * hint is a sentence that appears in their material, and a question is a
 * template wrapped around a name they used.
 *
 * It is plainly weaker than the model path (no analogies, no traps, no
 * "what you are still missing"), and the product says so on screen.
 */

export const MIN_CONCEPTS = 4;
export const MAX_CONCEPTS = 10;
export const MIN_QUESTIONS = 4;
export const MAX_QUESTIONS = 8;

const STOP = new Set(
  ("a,about,above,after,again,against,all,also,although,always,am,among,an,and,another,any,are,as,at,be,because,been," +
   "before,being,below,between,both,but,by,can,cannot,could,did,do,does,doing,done,down,during,each,either,else,even," +
   "every,few,first,for,from,further,get,gets,give,given,gives,had,has,have,having,he,her,here,hers,herself,him,himself," +
   "his,how,however,i,if,in,inside,into,is,it,its,itself,just,keep,less,like,make,makes,many,may,me,might,more,most," +
   "much,must,my,myself,neither,never,new,next,no,nor,not,now,of,off,often,on,once,one,only,onto,or,other,others,our," +
   "ours,out,over,own,per,rather,same,say,says,see,seen,several,shall,she,should,since,so,some,still,such,take,taken," +
   "than,that,the,their,theirs,them,themselves,then,there,therefore,these,they,thing,things,this,those,though,three," +
   "through,thus,to,together,too,two,under,until,up,upon,us,use,used,uses,using,very,was,way,we,well,were,what,when," +
   "where,whether,which,while,who,whom,whose,why,will,with,within,without,would,you,your,yours,yourself").split(",")
);

/** Words that never make a concept name on their own. */
const WEAK_HEAD = new Set(["it", "this", "that", "there", "they", "we", "you", "one", "example", "note", "figure", "table"]);

const ARTICLE = new Set(["the", "a", "an", "this", "these", "that", "those", "each", "every", "its", "their"]);

/**
 * A phrase that spans one of these has swallowed a clause. "Calcium matters
 * because it" is a sentence fragment, not something a student studies.
 */
const CONNECTIVE = new Set([
  "because", "which", "that", "when", "while", "where", "whether", "and", "but", "or", "so",
  "than", "then", "if", "although", "though", "since", "unless", "what", "how", "why", "with",
  "from", "into", "onto", "about", "after", "before", "during", "unlike",
]);

const DEFINITION = /^(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z0-9'’\-]*(?:\s+[A-Za-z0-9'’\-]+){0,3})\s+(?:is|are|was|were|refers?\s+to|means?|describes?|denotes?|can\s+be\s+defined\s+as|is\s+defined\s+as)\s+(?!not\b)/i;

export type Sentence = { text: string; chunkId: string; ordinal: number };

/** Sentences with the passage each came from, so a hint can cite its source. */
export function sentencesOf(chunks: SourceChunk[]): Sentence[] {
  const out: Sentence[] = [];
  for (const chunk of chunks) {
    const parts = chunk.text
      .split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 25 && /[a-z]/.test(s));
    for (const text of parts) out.push({ text, chunkId: chunk.id, ordinal: chunk.ordinal });
  }
  return out;
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s'’-]/g, " ").split(/\s+/).filter(Boolean);
}

function contentWords(s: string): string[] {
  return words(s).filter((w) => w.length > 3 && !STOP.has(w));
}

function titleCase(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function slug(name: string, taken: Set<string>): string {
  const base = `c_${words(name).filter((w) => !STOP.has(w)).slice(0, 3).join("_").replace(/[^a-z0-9_]/g, "")}` || "c_topic";
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  taken.add(id);
  return id;
}

type Candidate = {
  phrase: string;
  score: number;
  /** The sentence that best explains it, and where that sentence lives. */
  home: Sentence | null;
  defined: boolean;
};

/** Short unpunctuated lines read as headings, and headings name topics. */
function headingPhrases(rawText: string): string[] {
  return rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (l.length < 4 || l.length > 60) return false;
      if (/[.!?;:]$/.test(l)) return false;
      const w = words(l);
      return w.length >= 1 && w.length <= 6 && w.some((x) => !STOP.has(x) && x.length > 3);
    })
    .map((l) => l.replace(/^[\d.)\-\s]+/, "").trim())
    .filter(Boolean);
}

/**
 * The word a sentence opens with. Notes are written topic-first far more often
 * than not ("Fixation preserves…", "Steric hindrance is what kills SN2"), so
 * the first content word of a sentence is the cheapest honest signal there is
 * that the sentence is about that thing.
 */
function sentenceOpeners(sentences: Sentence[]): string[] {
  const out: string[] = [];
  for (const s of sentences) {
    const w = words(s.text);
    if (w.length < 7) continue;
    // Position 0, or position 1 behind an article. Anything else is the verb:
    // in "It oxidises succinate", the word after the pronoun is what the
    // sentence DOES, not what it is about, and "Oxidises" is not a concept.
    const i = ARTICLE.has(w[0]) ? 1 : 0;
    const first = w[i];
    if (first && first.length > 3 && !STOP.has(first) && !WEAK_HEAD.has(first)) out.push(first);
  }
  return out;
}

/** Repeated two- and three-word phrases made only of content words. */
function repeatedPhrases(sentences: Sentence[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sentences) {
    const w = words(s.text);
    for (let n = 3; n >= 2; n--) {
      for (let i = 0; i + n <= w.length; i++) {
        const span = w.slice(i, i + n);
        if (span.some((x) => STOP.has(x) || x.length < 3)) continue;
        const phrase = span.join(" ");
        counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function singleTermCounts(sentences: Sentence[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sentences) {
    for (const w of contentWords(s.text)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

/** The sentence that best introduces a phrase: a definition first, else overlap. */
function homeSentence(phrase: string, sentences: Sentence[]): { home: Sentence | null; defined: boolean } {
  const low = phrase.toLowerCase();
  let fallback: Sentence | null = null;
  for (const s of sentences) {
    const sl = s.text.toLowerCase();
    if (!sl.includes(low)) continue;
    const m = DEFINITION.exec(s.text);
    if (m && m[1].toLowerCase().includes(low.split(" ")[0])) return { home: s, defined: true };
    if (!fallback) fallback = s;
  }
  return { home: fallback, defined: false };
}

/**
 * Candidate topics, best first. Four signals, deliberately crude: a sentence
 * that defines something, a heading, a phrase that keeps recurring, and raw
 * term frequency for the words left over.
 */
export function candidateConcepts(chunks: SourceChunk[], rawText: string): Candidate[] {
  const sentences = sentencesOf(chunks);

  // A word that turns up in most sentences is the subject of the notes, not a
  // concept within them: "cycle" in a lecture about the citric acid cycle
  // tells a learner nothing about which part they are shaky on.
  const docFreq = new Map<string, number>();
  for (const s of sentences) {
    for (const w of new Set(contentWords(s.text))) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
  }
  const ubiquitous = (word: string) => (docFreq.get(word) ?? 0) / Math.max(1, sentences.length) > 0.35;

  const score = new Map<string, number>();
  const bump = (phrase: string, by: number) => {
    const key = phrase.trim().toLowerCase();
    if (!key || key.length < 4 || key.length > 60) return;
    const w = words(key);
    if (w.length === 0 || w.length > 4) return;
    if (w.every((x) => STOP.has(x) || WEAK_HEAD.has(x))) return;
    if (WEAK_HEAD.has(w[0]) && w.length === 1) return;
    if (w.some((x) => CONNECTIVE.has(x))) return;
    if (w.length === 1 && ubiquitous(w[0])) return;
    score.set(key, (score.get(key) ?? 0) + by);
  };

  for (const s of sentences) {
    const m = DEFINITION.exec(s.text);
    if (m) bump(m[1], 6);
  }
  for (const h of headingPhrases(rawText)) bump(h, 4);
  for (const opener of sentenceOpeners(sentences)) bump(opener, 2.2);
  for (const [phrase, n] of repeatedPhrases(sentences)) {
    if (n >= 2) bump(phrase, 1.5 + Math.min(n, 5) * 0.6);
  }
  for (const [term, n] of singleTermCounts(sentences)) {
    if (n >= 3) bump(term, Math.min(n, 6) * 0.35);
  }

  const ranked = [...score.entries()]
    .map(([phrase, sc]) => {
      const { home, defined } = homeSentence(phrase, sentences);
      return { phrase, score: sc + (defined ? 2 : 0) + (words(phrase).length > 1 ? 1 : 0), home, defined };
    })
    .filter((c) => c.home !== null)
    .sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));

  // Drop a phrase that is contained in a stronger one already kept — the
  // longer phrase becomes the concept and the shorter one becomes its alias.
  const kept: Candidate[] = [];
  for (const c of ranked) {
    if (kept.some((k) => k.phrase.includes(c.phrase) || c.phrase.includes(k.phrase))) continue;
    kept.push(c);
    if (kept.length >= MAX_CONCEPTS * 2) break;
  }
  return kept;
}

function aliasesFor(phrase: string, all: string[]): string[] {
  const out = new Set<string>();
  const w = words(phrase);
  if (w.length > 1) out.add(w[w.length - 1]);
  for (const other of all) {
    if (other !== phrase && (other.includes(phrase) || phrase.includes(other))) out.add(other);
  }
  out.delete(phrase);
  return [...out].filter((a) => a.length > 3).slice(0, 4);
}

/** Content words of the home sentence: what an answer has to mention. */
function keywordsFrom(sentence: string, conceptWords: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of contentWords(sentence)) {
    if (conceptWords.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length === 5) break;
  }
  if (out.length < 3) {
    for (const w of conceptWords) {
      if (out.length >= 3) break;
      if (!seen.has(w) && w.length > 3) { seen.add(w); out.push(w); }
    }
  }
  return out;
}

const QUESTION_TEMPLATES = [
  (n: string) => `In your own words, what is ${n}?`,
  (n: string) => `What is ${n}, and why does it matter here?`,
  (n: string) => `Explain ${n} without looking at your notes.`,
  (n: string) => `How would you describe ${n} to someone who has not read this?`,
  (n: string) => `What do your notes say about ${n}?`,
  (n: string) => `Where does ${n} come up, and what does it change?`,
  (n: string) => `Say everything you remember about ${n}.`,
  (n: string) => `What would you get wrong about ${n} if you rushed?`,
];

export type Extraction = {
  concepts: ConceptDef[];
  examQuestions: ExamQuestion[];
  explainers: Record<string, Explainer>;
  teachback: { keywords: Record<string, string[]>; hints: Record<string, string> };
  keyterms: string[];
};

/**
 * Build the whole subject body from the text alone. Returns null when the
 * material is too thin to make something worth studying — a short subject is
 * fine, a hollow one is not.
 */
export function extractSubjectBody(chunks: SourceChunk[], rawText: string): Extraction | null {
  const sentences = sentencesOf(chunks);
  if (sentences.length < 4) return null;

  const candidates = candidateConcepts(chunks, rawText).slice(0, MAX_CONCEPTS);
  if (candidates.length < MIN_CONCEPTS) return null;

  const phrases = candidates.map((c) => c.phrase);
  const taken = new Set<string>();
  const concepts: ConceptDef[] = [];
  const homes = new Map<string, Sentence>();
  const defined = new Map<string, boolean>();

  for (const c of candidates) {
    const name = titleCase(c.phrase);
    const id = slug(c.phrase, taken);
    concepts.push({
      id,
      name,
      aliases: aliasesFor(c.phrase, phrases),
      description: (c.home?.text ?? name).slice(0, 300),
      related: [],
    });
    if (c.home) homes.set(id, c.home);
    defined.set(id, c.defined);
  }

  // Two concepts that share a passage are related. Cheap, and true of the
  // learner's own material rather than of a model's idea of the field.
  const byChunk = new Map<string, string[]>();
  for (const con of concepts) {
    const home = homes.get(con.id);
    if (!home) continue;
    const list = byChunk.get(home.chunkId) ?? [];
    list.push(con.id);
    byChunk.set(home.chunkId, list);
  }
  for (const ids of byChunk.values()) {
    for (const id of ids) {
      const con = concepts.find((c) => c.id === id);
      if (con) con.related = ids.filter((x) => x !== id).slice(0, 3);
    }
  }

  const explainers: Record<string, Explainer> = {};
  const keywords: Record<string, string[]> = {};
  const hints: Record<string, string> = {};
  const examQuestions: ExamQuestion[] = [];

  concepts.forEach((con, i) => {
    const home = homes.get(con.id);
    const source = home?.text ?? con.description;
    const conceptWords = new Set(words(con.name));
    const required = keywordsFrom(source, conceptWords);
    const hint = `Your own notes: "${source.slice(0, 140)}${source.length > 140 ? "…" : ""}"`;

    explainers[con.id] = {
      formal: source,
      // No model read this, so there is no plain-language rewrite to offer.
      // The tutor falls back to the passage rather than inventing one.
      jargonFree: "",
      missing: [],
    };
    keywords[con.id] = required;
    hints[con.id] = hint;

    if (examQuestions.length < MAX_QUESTIONS && required.length >= 3) {
      examQuestions.push({
        id: `q_${con.id}`,
        conceptId: con.id,
        question: QUESTION_TEMPLATES[i % QUESTION_TEMPLATES.length](con.name),
        requiredKeywords: required.slice(0, 6),
        hint,
      });
    }
  });

  if (examQuestions.length < MIN_QUESTIONS) return null;

  const keyterms: string[] = [];
  const seen = new Set<string>();
  for (const con of concepts) {
    for (const term of [con.name, ...con.aliases]) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      keyterms.push(term);
      if (keyterms.length === 60) break;
    }
  }

  return { concepts, examQuestions, explainers, teachback: { keywords, hints }, keyterms };
}
