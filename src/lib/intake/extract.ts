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

/**
 * How much evidence a phrase needs before VIVA calls it a concept.
 *
 * A judge pasted 851 words of binary-search-tree notes and was handed
 * "Plain", "Correct" and "Practical difference" to revise, then asked three
 * times "Where does Plain come up, and what does it change?". Every one of
 * those was a one-off: an adjective that happened to open a sentence. The
 * floor is the price of admission — a sentence that defines the phrase, a
 * heading the student wrote, a phrase the notes come back to, or a term they
 * wrote as a symbol. What clears it is the map; there is no quota to fill.
 */
const MIN_CONCEPT_SCORE = 3.0;

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

/**
 * A word English has already marked as a thing rather than as a description.
 *
 * Notes written as a procedure name every step exactly once — "Fixation
 * preserves the structure", "Sectioning uses a microtome", "Counterstaining
 * adds a second colour" — so no amount of counting will find them. The shape
 * of the word will. "Correct", "Plain", "Single" and "Search" have no such
 * shape, which is precisely why they were being handed to a student as things
 * to revise.
 */
const NOUNY = /(?:tion|sion|ment|ness|ity|ance|ence|ism|ology|graphy|ing)s?$/;

const DEFINITION = /^(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z0-9'’\-]*(?:\s+[A-Za-z0-9'’\-]+){0,3})\s+(?:is|are|was|were|refers?\s+to|means?|describes?|denotes?|can\s+be\s+defined\s+as|is\s+defined\s+as)\s+(?!not\b)/i;

export type Sentence = { text: string; chunkId: string; ordinal: number };

/**
 * Sentences with the passage each came from, so a hint can cite its source.
 *
 * Once, and only once. Consecutive passages share a seam on purpose, so a
 * sentence sitting in the overlap is in the text twice — and everything below
 * counts: "does the phrase come back?" was answering yes for phrases said a
 * single time in a single paragraph, which is how "Node deep" became
 * something a student was asked to explain.
 */
export function sentencesOf(chunks: SourceChunk[]): Sentence[] {
  const out: Sentence[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const parts = chunk.text
      .split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 25 && /[a-z]/.test(s));
    for (const text of parts) {
      const key = text.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text, chunkId: chunk.id, ordinal: chunk.ordinal });
    }
  }
  return out;
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s'’-]/g, " ").split(/\s+/).filter(Boolean);
}

function contentWords(s: string): string[] {
  return words(s).filter((w) => w.length > 3 && !STOP.has(w));
}

function slug(name: string, taken: Set<string>): string {
  const base = `c_${words(name).filter((w) => !STOP.has(w)).slice(0, 3).join("_").replace(/[^a-z0-9_]/g, "")}` || "c_topic";
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  taken.add(id);
  return id;
}

/* -------------------------------------------------------------------- */
/*  What the notes themselves mark as terms                              */
/* -------------------------------------------------------------------- */

type Lexicon = {
  /** lowercase token → the shape the student actually wrote it in */
  form: Map<string, string>;
  /** tokens the notes treat as terms of art rather than ordinary words */
  distinctive: Set<string>;
};

const WORDISH = /[A-Za-z0-9][A-Za-z0-9'’]*(?:-[A-Za-z0-9'’]+)*/g;

/**
 * One pass over the learner's text for the words it treats as terms.
 *
 * There is no dictionary here and there is not going to be one. What there is
 * instead is the way the student wrote it down: KM, Vmax, AVL, SN2,
 * red-black, Lineweaver-Burk and Michaelis are marked as terms by their own
 * shape — a symbol, an acronym, a hyphenated compound, or a name capitalised
 * in the middle of a sentence. "correct", "plain" and "single" are not,
 * however many sentences they open. Capitals inside a heading line are
 * ignored, because every word in a title is capitalised and none of that says
 * anything about which of them is a term.
 *
 * This matters twice over. A term is allowed to be a concept even when it is
 * all over the notes — Vmax is what enzyme-kinetics notes are about, and
 * suppressing it as "too common" is how the map came out naming everything
 * except the thing on the page. And it is the only single word VIVA will
 * attach as an alias, because a bare ordinary word as an alias is what tells
 * a student they are wrong when they are right.
 */
function readLexicon(rawText: string): Lexicon {
  const form = new Map<string, string>();
  const distinctive = new Set<string>();
  for (const rawLine of rawText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = !/[.!?]$/.test(line);
    let opens = true;
    for (const m of line.matchAll(WORDISH)) {
      const token = m[0];
      const at = m.index ?? 0;
      const key = token.toLowerCase().replace(/^[-'’]+|[-'’]+$/g, "");
      const nextOpens = /[.!?]/.test(line[at + token.length] ?? "");
      if (key) {
        const symbol =
          (/[A-Za-z]/.test(token) && /\d/.test(token)) ||
          /[A-Za-z]-[A-Za-z]/.test(token) ||
          /[A-Z]/.test(token.slice(1));
        const named = !heading && !opens && /^[A-Z]/.test(token);
        if (symbol || named) {
          distinctive.add(key);
          if (!form.has(key) || form.get(key) === key) form.set(key, token);
        } else if (!form.has(key)) {
          form.set(key, opens || heading ? key : token);
        }
      }
      opens = nextOpens;
    }
  }
  return { form, distinctive };
}

/** The phrase written the way the student writes it: "AVL trees", not "Avl trees". */
function displayName(phrase: string, lex: Lexicon): string {
  const out = words(phrase).map((w) => lex.form.get(w) ?? w).join(" ").trim();
  if (!out) return phrase;
  return /^[a-z]/.test(out) ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

/**
 * Does the first phrase contain the second, as words rather than as letters?
 *
 * On raw characters "non-competitive inhibitor" contains "competitive
 * inhibitor", so the notes' own contrast between the two collapses into one
 * concept with the other as its alias — and a student's claim about the one
 * gets checked against the passage about its opposite. Whole words only.
 */
function covers(outer: string, inner: string): boolean {
  const a = words(outer);
  const b = words(inner);
  if (!b.length || b.length > a.length) return false;
  for (let i = 0; i + b.length <= a.length; i++) {
    if (b.every((w, j) => a[i + j] === w)) return true;
  }
  return false;
}

/** How many times the notes say a phrase, counted on whole words. */
function phraseCounter(sentences: Sentence[]): (phrase: string) => number {
  const hay = sentences.map((s) => ` ${words(s.text).join(" ")} `);
  return (phrase: string) => {
    const needle = ` ${phrase} `;
    let n = 0;
    for (const line of hay) {
      let i = line.indexOf(needle);
      while (i !== -1) {
        n += 1;
        i = line.indexOf(needle, i + 1);
      }
    }
    return n;
  };
}

type Candidate = {
  phrase: string;
  score: number;
  /** The sentence that best explains it, and where that sentence lives. */
  home: Sentence | null;
  defined: boolean;
  /** Weaker phrases this one swallowed — the honest source of its aliases. */
  absorbed: string[];
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
 * What each sentence is about, taken as a phrase rather than as a word.
 *
 * Notes are written topic-first — "A binary search tree stores keys…",
 * "Red-black trees make a looser promise…" — so the opening of a sentence is
 * the cheapest honest signal there is. Reading only the *first* word of it is
 * what produced "Plain", "Correct" and "Single": in English the word in front
 * of the topic is usually an adjective describing it. So take the run of
 * content words the sentence opens with, and keep it only if it is something
 * the notes come back to. "binary search tree" and "competitive inhibitor"
 * survive; "the practical difference" and "the correct validity check", each
 * said once and never again, do not — a sentence is not a topic.
 */
function sentenceSubjects(
  sentences: Sentence[],
  recurs: (phrase: string) => boolean,
  worthNaming: (phrase: string) => boolean,
  nounish: (word: string) => boolean
): { phrase: string; weight: number }[] {
  const out: { phrase: string; weight: number }[] = [];
  for (const s of sentences) {
    const w = words(s.text);
    if (w.length < 7) continue;
    const bare = !ARTICLE.has(w[0]);
    let i = bare ? 0 : 1;
    const run: string[] = [];
    while (i < w.length && run.length < 3) {
      const x = w[i];
      if (STOP.has(x) || CONNECTIVE.has(x) || WEAK_HEAD.has(x) || x.length < 3) break;
      run.push(x);
      i += 1;
    }
    // Longest first while the whole phrase recurs, because that is the term
    // ("binary search tree", not "binary search"). Failing that, shortest
    // first, because the words trailing a one-off opening are the verb:
    // "Lineweaver-Burk plot linearises" is not a thing, "Lineweaver-Burk
    // plot" is.
    let picked = "";
    for (let n = run.length; n >= 2 && !picked; n--) {
      const phrase = run.slice(0, n).join(" ");
      if (nounish(run[n - 1]) && recurs(phrase)) picked = phrase;
    }
    for (let n = 2; n <= run.length && !picked; n++) {
      const phrase = run.slice(0, n).join(" ");
      if (nounish(run[n - 1]) && worthNaming(phrase)) picked = phrase;
    }
    // One word on its own, but only when the sentence opens straight onto it
    // with no determiner in front and the word is a nominalisation. Behind a
    // determiner the first word is usually the adjective in front of the
    // topic, and that is the whole provenance of "Plain", "Correct" and
    // "Single"; in front of one, it is the topic.
    if (!picked && bare && run.length && run[0].length > 5 && NOUNY.test(run[0])) {
      // "Quality control checks that…" is about quality control, not about
      // quality; "Fixation preserves…" is about fixation, and the verb after
      // it is not part of the name.
      const pair = run.length > 1 && nounish(run[1]) ? `${run[0]} ${run[1]}` : run[0];
      // The only evidence there will ever be for a step named once, so it has
      // to be enough on its own.
      out.push({ phrase: pair, weight: 3.2 });
      continue;
    }
    if (picked) out.push({ phrase: picked, weight: 2.2 });
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
    for (const w of words(s.text)) {
      if (w.length < 2 || STOP.has(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The sentence that best introduces a phrase: a definition first, then the
 * sentence that opens closest to it. A phrase mentioned in passing at the end
 * of a sentence is not what that sentence is about, and the description, the
 * hint and the answer key are all cut from this one line.
 */
function homeSentence(phrase: string, sentences: Sentence[]): { home: Sentence | null; defined: boolean } {
  const low = phrase.toLowerCase();
  let best: { sentence: Sentence; at: number } | null = null;
  for (const s of sentences) {
    const at = s.text.toLowerCase().indexOf(low);
    if (at === -1) continue;
    const m = DEFINITION.exec(s.text);
    if (m && m[1].toLowerCase().includes(low.split(" ")[0])) return { home: s, defined: true };
    if (!best || at < best.at) best = { sentence: s, at };
  }
  return { home: best?.sentence ?? null, defined: false };
}

/**
 * Candidate topics, best first. Five signals, deliberately crude: a sentence
 * that defines something, a heading, the phrase a sentence opens with, a
 * phrase that keeps recurring, and the terms the student wrote as symbols.
 */
export function candidateConcepts(chunks: SourceChunk[], rawText: string): Candidate[] {
  const sentences = sentencesOf(chunks);
  const lex = readLexicon(rawText);
  const occurs = phraseCounter(sentences);

  // An ordinary word that turns up in most sentences is the subject of the
  // notes, not a concept within them: "cycle" in a lecture about the citric
  // acid cycle tells a learner nothing about which part they are shaky on.
  // A term of art is exempt — Vmax is in half the sentences of enzyme notes
  // *because* it is one of the things they are about.
  const docFreq = new Map<string, number>();
  for (const s of sentences) {
    for (const w of new Set(contentWords(s.text))) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
  }
  const ubiquitous = (word: string) => (docFreq.get(word) ?? 0) / Math.max(1, sentences.length) > 0.35;

  const termCount = singleTermCounts(sentences);

  /**
   * Is this phrase a thing the notes keep coming back to?
   *
   * The two signals that read a *sentence* — the phrase it opens with, and
   * the phrase it defines — are the ones that produced "Practical
   * difference", "Correct" and "Plain": each is a perfectly good English noun
   * phrase that the notes use exactly once, in passing. A topic recurs. So
   * both signals are held to it: either the whole phrase comes back, or its
   * head noun does, or it carries a term the student wrote as a symbol.
   */
  const recurs = (phrase: string) => occurs(phrase) >= 2;
  /**
   * Could this word be the head of a name?
   *
   * "The rate depends on the concentration" opens on a noun phrase and then a
   * verb, and both are content words, so "Rate depends" was being offered as
   * something to revise. English marks the third person with the same -s it
   * marks a plural with — but a plural noun almost always has its singular in
   * the notes too ("trees" beside "tree", "mechanisms" beside "mechanism"),
   * and "depends", "uses" and "applies" do not.
   */
  const nounish = (word: string) => !/s$/.test(word) || termCount.has(word.replace(/s$/, ""));
  const worthNaming = (phrase: string): boolean => {
    const w = words(phrase);
    if (!w.length) return false;
    if (recurs(phrase)) return true;
    if (w.some((x) => lex.distinctive.has(x))) return true;
    return (termCount.get(w[w.length - 1]) ?? 0) >= 2;
  };

  const score = new Map<string, number>();
  const bump = (phrase: string, by: number) => {
    const key = phrase.trim().toLowerCase();
    if (!key || key.length > 60) return;
    const w = words(key);
    if (w.length === 0 || w.length > 4) return;
    const solo = w.length === 1;
    const term = solo && lex.distinctive.has(w[0]);
    if (key.length < (term ? 2 : 4)) return;
    if (w.every((x) => STOP.has(x) || WEAK_HEAD.has(x))) return;
    if (solo && WEAK_HEAD.has(w[0])) return;
    if (w.some((x) => CONNECTIVE.has(x))) return;
    if (solo && !term && ubiquitous(w[0])) return;
    score.set(key, (score.get(key) ?? 0) + by);
  };

  for (const s of sentences) {
    const m = DEFINITION.exec(s.text);
    if (!m) continue;
    // "Every node is coloured red or black" is about nodes, not about "every
    // node". The regex only strips the/a/an; the rest of the determiners are
    // just as much noise in a concept name.
    const subject = words(m[1]);
    const named = (ARTICLE.has(subject[0]) && subject.length > 1 ? subject.slice(1) : subject).join(" ");
    if (worthNaming(named)) bump(named, 4);
  }
  for (const h of headingPhrases(rawText)) bump(h, 4);
  for (const s of sentenceSubjects(sentences, recurs, worthNaming, nounish)) bump(s.phrase, s.weight);
  for (const [phrase, n] of repeatedPhrases(sentences)) {
    if (n >= 2) bump(phrase, 1.5 + Math.min(n, 5) * 0.6);
  }
  for (const [term, n] of termCount) {
    // A term the student wrote as a symbol earns its place on repetition
    // alone; an ordinary word has to be a great deal more insistent.
    if (lex.distinctive.has(term)) {
      if (n >= 2) bump(term, 1.5 + Math.min(n, 5) * 0.6);
    } else if (n >= 3 && term.length > 3) {
      bump(term, Math.min(n, 6) * 0.35);
    }
  }

  const ranked = [...score.entries()]
    .map(([phrase, sc]) => {
      const { home, defined } = homeSentence(phrase, sentences);
      return {
        phrase,
        score: sc + (defined ? 1.5 : 0) + (words(phrase).length > 1 ? 1 : 0),
        home,
        defined,
        absorbed: [] as string[],
      };
    })
    .filter((c) => c.home !== null)
    .sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));

  // Drop a phrase that is contained in a stronger one already kept — the
  // longer phrase becomes the concept and the shorter one becomes its alias —
  // and stop at the floor rather than padding the map out to ten.
  const kept: Candidate[] = [];
  for (const c of ranked) {
    if (c.score < MIN_CONCEPT_SCORE) break;
    const host = kept.find((k) => covers(k.phrase, c.phrase) || covers(c.phrase, k.phrase));
    if (host) {
      // A bare word holding the slot gives it up to the phrase that spells it
      // out: "height" scores highest in tree notes because it is in every
      // other sentence, and it was swallowing "AVL height bound" — two
      // different things a student is examined on, filed as one.
      const single = words(host.phrase).length === 1 && !lex.distinctive.has(host.phrase);
      if (single && covers(c.phrase, host.phrase)) {
        c.absorbed.push(host.phrase, ...host.absorbed);
        kept[kept.indexOf(host)] = c;
      } else {
        host.absorbed.push(c.phrase);
      }
      continue;
    }
    // Past the cap, keep reading: a term further down the list is still the
    // alias of something already kept, and dropping it loses the word the
    // student will actually say.
    if (kept.length < MAX_CONCEPTS) kept.push(c);
  }
  return kept;
}

/**
 * What else the student might call it.
 *
 * The claim checker matches what a student says against concept names and
 * aliases, so an alias is the difference between VIVA reading their sentence
 * and skipping it. It is also the fastest way to tell somebody they are wrong
 * when they are right: a bare ordinary word — "cost", "order", "difference",
 * "tree" — matches almost any sentence and drags the wrong passage in behind
 * it. So an alias is only ever a phrase this concept already swallowed — a
 * longer or shorter wording of the same thing, which the notes themselves
 * use — and a single word may only be one of those when the student wrote it
 * as a term ("KM" under "Michaelis constant KM", "AVL" under "AVL trees").
 * Never a bare ordinary word. Nothing from merely nearby, either: "KM" is in
 * every sentence of those notes, and hanging it on all five concepts would
 * point every claim mentioning it at whichever one happened to be listed
 * first.
 */
function aliasesFor(c: Candidate, lex: Lexicon): string[] {
  const out = new Set<string>();
  for (const other of c.absorbed) {
    if (words(other).length > 1 || lex.distinctive.has(other)) out.add(displayName(other, lex));
  }
  return [...out].slice(0, 4);
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

  const lex = readLexicon(rawText);
  const candidates = candidateConcepts(chunks, rawText).slice(0, MAX_CONCEPTS);
  if (candidates.length < MIN_CONCEPTS) return null;

  const usedIds = new Set<string>();
  const concepts: ConceptDef[] = [];
  const homes = new Map<string, Sentence>();

  for (const c of candidates) {
    const name = displayName(c.phrase, lex);
    concepts.push({
      id: slug(c.phrase, usedIds),
      name,
      aliases: aliasesFor(c, lex),
      description: (c.home?.text ?? name).slice(0, 300),
      related: [],
    });
    if (c.home) homes.set(concepts[concepts.length - 1].id, c.home);
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
