/**
 * Text handling for claim checking.
 *
 * Deliberately small and inspectable. Every rule here is one a reviewer can
 * read and disagree with; there is no model in this file and no hidden score.
 * The verdict a claim gets is a consequence of these rules applied to the
 * document's own words, and the evidence it cites is always a passage the
 * document actually contains.
 */

const STOP = new Set(
  ("a,an,the,and,or,of,to,in,is,it,its,that,this,these,those,with,for,on,as,at,by,from,be,are,was,were,been,being," +
    "we,our,us,you,your,they,their,them,he,she,his,her,i,my,me,there,here,so,very,really,just,also,then,than,when,if," +
    "will,would,should,can,could,may,might,must,shall,do,does,did,done,have,has,had,into,onto,over,under,about,any,all," +
    "each,every,both,some,such,which,who,whom,what,why,how,where,while,because,per,via,up,out,off,too,yes,yeah,well," +
    "actually,basically,currently,always,still,even,though,although,thing,things,stuff,way,make,made,get,got,use,used,uses,using")
    .split(",")
);

/** Words that flip what a clause asserts. Kept separate from STOP on purpose. */
export const NEGATION = /\b(?:not|no|never|neither|nor|without|cannot|cant|isnt|arent|doesnt|dont|didnt|wont|wasnt|werent|hasnt|havent|lack|lacks|lacking|absent|missing|disabled|excluded|nonexistent|unsupported|unimplemented|unconfigured)\b/i;

/** "Planned", "TBD", "future work": the document says it is not true today. */
export const NOT_YET = /\b(?:planned|future work|roadmap|tbd|todo|not yet|intend(?:s|ed)? to|will eventually|proposed|considering|out of scope|non-goal)\b/i;

/** A speaker who is not committing to the sentence. */
export const HEDGE = /\b(?:maybe|perhaps|probably|possibly|i think|i guess|i believe|not sure|kind of|sort of|might|i suppose)\b/i;

export const CORRECTION_CUE =
  /\b(?:i meant|i mean|what i meant|i said|i should have said|correction|let me correct|to be clear|rather|sorry,? i|no,? i|wait,? i|actually,? (?:it|we|i|that|the|its|it's))\b|^\s*(?:wait|hold on|sorry|actually|no)[,.!\s]/i;

/** Pairs where each word is the other's opposite in an engineering document. */
const OPPOSITES: [string, string][] = [
  ["automatic", "manual"],
  ["synchronous", "asynchronous"],
  ["sync", "async"],
  ["encrypted", "plaintext"],
  ["stateful", "stateless"],
  ["blocking", "nonblocking"],
  ["single", "multiple"],
  ["public", "private"],
  ["enabled", "disabled"],
  ["online", "offline"],
  ["strong", "eventual"],
  ["mutable", "immutable"],
];

const OPPOSITE = new Map<string, string>();
for (const [a, b] of OPPOSITES) {
  OPPOSITE.set(a, b);
  OPPOSITE.set(b, a);
}

/** Words that qualify HOW a thing is done. A claim about one is a claim about the qualifier. */
export const QUALIFIERS: ReadonlySet<string> = new Set(OPPOSITE.keys());

export function oppositeOf(stem: string): string | null {
  return OPPOSITE.get(stem) ?? null;
}

const COMPOUNDS: [RegExp, string][] = [
  [/\bfail(?:s|ed|ing)?[\s-]?over(?:s)?\b/g, "failover"],
  [/\bfall[\s-]?back(?:s)?\b/g, "fallback"],
  [/\bread[\s-]?only\b/g, "readonly"],
  [/\broll[\s-]?back(?:s)?\b/g, "rollback"],
  [/\bback[\s-]?up(?:s)?\b/g, "backup"],
  [/\btime[\s-]?out(?:s)?\b/g, "timeout"],
  [/\bre[\s-]?try(?:ing)?\b/g, "retry"],
  [/\bnon[\s-]blocking\b/g, "nonblocking"],
  [/\bsingle[\s-]point[\s-]of[\s-]failure\b/g, "spof"],
  [/\bon[\s-]call\b/g, "oncall"],
  [/\bsoc[\s-]?2\b/g, "soc2"],
  [/\bfail[\s-]safe\b/g, "failsafe"],
];

const ALIAS: Record<string, string> = {
  automat: "automatic",
  automated: "automatic",
  automation: "automatic",
  manually: "manual",
  retries: "retry",
  retried: "retry",
  replicas: "replica",
  replicated: "replica",
  replication: "replica",
  promote: "promot",
  promotes: "promot",
  promoted: "promot",
  promotion: "promot",
  cache: "cach",
  cached: "cach",
  caches: "cach",
  caching: "cach",
  consistent: "consistency",
  consistently: "consistency",
  compliant: "compliance",
  certified: "certification",
  guarantees: "guarantee",
  guaranteed: "guarantee",
  audited: "audit",
  audits: "audit",
  unavailable: "unavailable",
  down: "unavailable",
  dies: "unavailable",
  crash: "unavailable",
  crashes: "unavailable",
  one: "single",
  keep: "retain",
  keeps: "retain",
  kept: "retain",
  store: "retain",
  stores: "retain",
  stored: "retain",
  retained: "retain",
  retains: "retain",
  recovery: "failover",
  recover: "failover",
  recovers: "failover",
  fails: "fail",
  failed: "fail",
  failing: "fail",
  failure: "fail",
  failures: "fail",
};

/** Cheap suffix stripping. Wrong stems are fine so long as both sides get the same one. */
export function stem(raw: string): string {
  let w = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (ALIAS[w]) return ALIAS[w];
  if (w.length <= 3) return w;
  if (w.endsWith("ically")) w = w.slice(0, -6) + "ic";
  else if (w.endsWith("ally") && w.length > 6) w = w.slice(0, -2);
  else if (w.endsWith("ily")) w = w.slice(0, -3) + "y";
  else if (w.endsWith("ly") && w.length > 5) w = w.slice(0, -2);
  if (ALIAS[w]) return ALIAS[w];
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return ALIAS[w] ?? w;
}

export function compact(text: string): string {
  let t = text.toLowerCase().replace(/[’']/g, "");
  for (const [re, to] of COMPOUNDS) t = t.replace(re, to);
  return t;
}

/** Content stems of a string: stopwords out, compounds joined, stems canonical. */
export function contentStems(text: string): string[] {
  const out: string[] = [];
  for (const w of compact(text).split(/[^a-z0-9]+/)) {
    if (!w || STOP.has(w)) continue;
    if (/^\d+$/.test(w)) continue; // numbers are compared separately, with their unit
    const s = stem(w);
    if (s.length < 2 || STOP.has(s)) continue;
    out.push(s);
  }
  return out;
}

export function stemSet(text: string): Set<string> {
  return new Set(contentStems(text));
}

/** Split text into clauses, the scope inside which a negation applies. */
export function clauses(sentence: string): string[] {
  return sentence
    .split(/[;:]|,\s*(?:but|and then|so)\s+|\s+(?:but|however|although|whereas|instead)\s+|\s+—\s+|\s+-\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Sentences, without splitting on "e.g.", version numbers or decimals. */
export function sentences(paragraph: string): string[] {
  const guarded = paragraph
    .replace(/\b(e\.g|i\.e|vs|etc|approx|fig|no|sec)\./gi, (m) => m.replace(".", "\u0000"))
    .replace(/(\d)\.(\d)/g, "$1\u0001$2");
  return guarded
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.replace(/\u0000/g, ".").replace(/\u0001/g, ".").trim())
    .filter(Boolean);
}

export type Figure = { value: number; unit: string; raw: string };

/** "3 retries", "30 minutes", "90 days": a number and the word it counts. */
export function figures(text: string): Figure[] {
  const out: Figure[] = [];
  const t = compact(text);
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    twice: 2, thrice: 3,
  };
  const re = /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twice|thrice)\s*(?:x\s+)?([a-z][a-z-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const value = words[m[1]] ?? Number(m[1]);
    if (!Number.isFinite(value)) continue;
    out.push({ value, unit: stem(m[2]), raw: m[2] });
  }
  return out;
}

/** Strip anything from a document that reads as an instruction to the agent. */
export function neutralise(text: string): string {
  return text
    .replace(/\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules)\b/gi, "[quoted phrase removed]")
    .replace(/\b(?:disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions?|prompts?|rules)\b/gi, "[quoted phrase removed]")
    .replace(/\byou\s+are\s+now\b[^.\n]*/gi, "[quoted phrase removed]")
    .replace(/\bsystem\s+prompt\b/gi, "[quoted phrase removed]")
    .replace(/\bnew\s+instructions?\s*:/gi, "[quoted phrase removed]:");
}
