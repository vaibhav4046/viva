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
    "actually,basically,currently,always,still,even,though,although,thing,things,stuff,way,make,made,get,got,use,used,uses,using," +
    "least,most,than,within,exactly,approximately,around,roughly")
    .split(",")
);

/** Words that flip what a clause asserts. Kept separate from STOP on purpose. */
export const NEGATION = /\b(?:not|no|never|neither|nor|cannot|cant|isnt|arent|doesnt|dont|didnt|wont|wasnt|werent|hasnt|havent|lack|lacks|lacking|absent|missing|disabled|excluded|nonexistent|unsupported|unimplemented|unconfigured|out of scope|not in scope|non-goal)\b/i;

/** "Planned", "TBD", "future work": the document says it is not true today. */
export const NOT_YET = /\b(?:future work|roadmap|tbd|todo|not yet|will eventually|considering)\b/i;

/**
 * A document stating a plan, an expectation or a recommendation rather than a
 * fact. A claim that states the same thing as fact is at most PARTIAL: "GA is
 * planned for 1 June" backs "GA is 1 June" only as a plan.
 */
export const SOFT = /\b(?:should|may|might|could|expects?|expected|expecting|aims? to|planned|plans? to|planning to|targets? to|estimates?|estimated|projected|forecast(?:s|ed)?|intends?|intended|hopes? to|proposed)\b/i;

/** Words that make a claim absolute. If the passage does not say them too, it is not backing the absolute. */
export const ABSOLUTE = /\b(?:always|never|all|every|most|majority|guarantees?|guaranteed|must|without exception|in every case)\b/i;

/** Labels whose number names a thing rather than counting it: "Severity 1", "version 2", "tier 3". */
export const IDENT_SLOTS: ReadonlySet<string> = new Set(["severity", "sev", "version", "tier", "level", "phase", "priority", "step", "round", "stage", "wave", "option", "plan", "release", "p"]);

/** A speaker who is not committing to the sentence. */
export const HEDGE = /\b(?:maybe|perhaps|probably|possibly|i think|i guess|i believe|not sure|kind of|sort of|might|i suppose)\b/i;

export const CORRECTION_CUE =
  /\b(?:i meant|i mean|what i meant|i said|i should have said|correction|let me correct|to be clear|rather)\b|^\s*(?:wait|hold on|sorry|actually)[,.!\s]/i;

/** Verbs that say a thing is refused or stopped. A passage that has one the claim lacks is not agreeing with it. */
export const NEG_VERBS: ReadonlySet<string> = new Set(["reject", "block", "refus", "deny", "drop", "prevent", "forbid", "disallow", "discard", "skip", "ignor", "abort"]);

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

/** Words that qualify HOW a thing is done. A claim about one is a claim about the qualifier. */
export const QUALIFIERS: Set<string> = new Set();

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
  postgresql: "postgres",
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
const dropE = (w: string) => (w.length > 4 && w.endsWith("e") ? w.slice(0, -1) : w);

export function stem(raw: string): string {
  let w = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (ALIAS[w]) return dropE(ALIAS[w]);
  if (w.length <= 3) return w;
  if (w.endsWith("ically")) w = w.slice(0, -6) + "ic";
  else if (w.endsWith("ally") && w.length > 6) w = w.slice(0, -2);
  else if (w.endsWith("ily")) w = w.slice(0, -3) + "y";
  else if (w.endsWith("ly") && w.length > 5) w = w.slice(0, -2);
  if (ALIAS[w]) return dropE(ALIAS[w]);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 4 && /(?:ss|sh|ch|x|z|o)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  // A trailing "e" is dropped so cite / cites / cited / citing meet at one stem.
  return dropE(ALIAS[w] ?? w);
}

// The opposite pairs are stemmed exactly as claims and passages are, so
// "single", "automatically" and "eventually" meet their entries here. Built
// after `stem` and `ALIAS` exist.
for (const [a, b] of OPPOSITES) {
  const sa = stem(a);
  const sb = stem(b);
  OPPOSITE.set(sa, sb);
  OPPOSITE.set(sb, sa);
  QUALIFIERS.add(sa);
  QUALIFIERS.add(sb);
}

export function compact(text: string): string {
  // Country and bloc codes before lowercasing, or "US" becomes the stopword "us".
  let t = text
    .replace(/\bU\.?S\.?A?\b(?!\w)/g, " usa ")
    .replace(/\bU\.?K\.?\b(?!\w)/g, " uk ")
    .toLowerCase()
    .replace(/[’']/g, "");
  for (const [re, to] of COMPOUNDS) t = t.replace(re, to);
  return t;
}

/** Content stems of a string: stopwords out, compounds joined, stems canonical. */
export function contentStems(text: string): string[] {
  const out: string[] = [];
  for (const w of compact(normaliseAmounts(text)).split(/[^a-z0-9]+/)) {
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

/**
 * Split text into clauses, the scope inside which a negation applies.
 *
 * "X is hashed, and Y is never stored" is two statements: the negation belongs
 * to the second only. A clause is therefore also split at "and" when exactly
 * one side carries a negation cue.
 */
export function clauses(sentence: string): string[] {
  const base = sentence
    .split(/[;:]|,\s*(?:but|and then|so|provided|unless|except|as long as)\s+|\s+(?:but|however|although|whereas|instead|provided that|unless|as long as)\s+|\s+—\s+|\s+-\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const c of base) {
    const parts = c.split(/,?\s+and\s+/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2 && NEGATION.test(compact(parts[0])) !== NEGATION.test(compact(parts[1]))) out.push(...parts);
    else out.push(c);
  }
  return out;
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

export const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  twenty: 20, thirty: 30, fifty: 50, hundred: 100, thousand: 1000, twice: 2, thrice: 3,
};

/** "3 retries", "30 minutes", "90 days", "one year": a number and the word it counts. */
export function figures(text: string): Figure[] {
  const out: Figure[] = [];
  const t = compact(text);
  const re = /\b(\d+(?:\.\d+)?|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|fifty|hundred|thousand|twice|thrice)\s*(?:x\s+)?([a-z][a-z-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const value = NUMBER_WORDS[m[1]] ?? Number(m[1]);
    if (!Number.isFinite(value)) continue;
    out.push({ value, unit: stem(m[2]), raw: m[2] });
  }
  return out;
}

/**
 * Every number a text states, as strings ("3", "1.2", "90"), clock times
 * excluded. Version numbers count: "TLS 1.2" is not "TLS 1.3".
 */
export function numbers(text: string): Set<string> {
  const t = normaliseAmounts(compact(stripClock(text)));
  const out = new Set<string>();
  for (const m of t.matchAll(/\b\d+(?:\.\d+)*\b/g)) out.add(m[0]);
  for (const m of t.matchAll(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|fifty|hundred|thousand|twice|thrice)\b/g)) out.add(String(NUMBER_WORDS[m[1]]));
  return out;
}

/**
 * "3,000" is 3000, "$2.4M" and "2.4 million dollars" are the same amount,
 * "$4.1B" is 4100 million. Amounts are compared in one spelling so a
 * formatting difference is never read as a different number.
 */
export function normaliseAmounts(t: string): string {
  return t
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/\$\s?(\d+(?:\.\d+)?)\s*(?:mn|m|million)\b/g, (_, n) => ` ${Number(n)} million `)
    .replace(/\$\s?(\d+(?:\.\d+)?)\s*(?:bn|b|billion)\b/g, (_, n) => ` ${Math.round(Number(n) * 1000 * 1000) / 1000} million `)
    .replace(/\b(\d+(?:\.\d+)?)\s*billion\b/g, (_, n) => ` ${Math.round(Number(n) * 1000 * 1000) / 1000} million `)
    .replace(/\$\s?(\d+(?:\.\d+)?)\s*k\b/g, (_, n) => ` ${Number(n) * 1000} `)
    .replace(/\$\s?(\d)/g, "$1");
}

export type Bound = "exact" | "min" | "max";
export type Quantity = { value: number; unit: string; bound: Bound; strict: boolean; slot: string };

const TIME_SECONDS: Record<string, number> = { second: 1, minut: 60, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };

/** A time quantity in seconds, when the unit is a time unit. */
export function inSeconds(q: Quantity): number | null {
  const s = TIME_SECONDS[q.unit];
  return s ? q.value * s : null;
}

/**
 * Every number in a text with what it counts, the bound around it ("at least",
 * "up to", "more than", "within") and the word before it (its slot: "TLS 1.2",
 * "autumn 2023"). Clock times are excluded; they are compared separately.
 */
export function quantities(text: string): Quantity[] {
  const t = normaliseAmounts(compact(stripClock(text)));
  const toks = t.split(/[^a-z0-9.]+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter(Boolean);
  const out: Quantity[] = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    const value = /^\d+(?:\.\d+)?$/.test(w) ? Number(w) : NUMBER_WORDS[w];
    if (value === undefined || !Number.isFinite(value)) continue;
    let j = i + 1;
    while (j < toks.length && /^(?:x|times?)$/.test(toks[j]) && toks[j] !== "times") j++;
    const next = toks[j] ?? "";
    const unit = next && !/^\d/.test(next) && !STOP.has(next) ? stem(next) : "";
    const before = toks.slice(Math.max(0, i - 3), i).join(" ");
    let bound: Bound = "exact";
    let strict = false;
    if (/(?:at least|minimum of|no fewer than|no less than)$/.test(before)) bound = "min";
    else if (/(?:more than|over|above|greater than|exceeds?|exceeding)$/.test(before)) (bound = "min"), (strict = true);
    else if (/(?:up to|at most|maximum of|no more than|within|not exceed|capped at)$/.test(before)) bound = "max";
    else if (/(?:less than|under|below|fewer than)$/.test(before)) (bound = "max"), (strict = true);
    let k = i - 1;
    while (k >= 0 && (STOP.has(toks[k]) || /^(?:least|most|than|up|over|under|above|below|within|to|of)$/.test(toks[k]))) k--;
    out.push({ value, unit, bound, strict, slot: k >= 0 ? stem(toks[k]) : "" });
  }
  return out;
}

/** Does value `v` satisfy quantity `q`'s bound? */
export function satisfies(v: number, q: Quantity): boolean {
  if (q.bound === "exact") return v === q.value;
  if (q.bound === "min") return q.strict ? v > q.value : v >= q.value;
  return q.strict ? v < q.value : v <= q.value;
}

const CLOCK = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b|\b(midnight|noon)\b/gi;

function stripClock(text: string): string {
  return text.replace(CLOCK, " ");
}

/** Times of day, normalised to HH:MM on a 24-hour clock. */
export function clockTimes(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(CLOCK)) {
    let h: number;
    let min = 0;
    if (m[6]) {
      h = m[6].toLowerCase() === "midnight" ? 0 : 12;
    } else {
      h = Number(m[1] ?? m[4]);
      min = m[2] ? Number(m[2]) : 0;
      const ap = (m[3] ?? m[5])?.toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
    }
    out.add(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  }
  return out;
}

/** "per minute", "each day", "every hour": the period a rate is quoted over. */
export function periods(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of compact(text).matchAll(/\b(?:per|each|every|a|an)\s+(second|minute|hour|day|week|month|year)\b/g)) out.add(m[1]);
  for (const m of compact(text).matchAll(/\b(hourly|daily|weekly|monthly|yearly|nightly)\b/g)) {
    out.add({ hourly: "hour", daily: "day", weekly: "week", monthly: "month", yearly: "year", nightly: "day" }[m[1] as string] as string);
  }
  return out;
}

/**
 * Soften anything in a document that reads as an instruction to the agent.
 *
 * This is a blocklist and blocklists leak; it is the SECOND line of defence.
 * The first is structural: the document is never in the system prompt, no tool
 * takes a verdict, and `finish_redteam_session` needs the user to have asked.
 */
export function neutralise(text: string): string {
  const cut = "[quoted phrase removed]";
  return text
    .replace(/\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|every(?:thing)?\s+)*(?:previous|prior|above|earlier|preceding|system|safety)?\s*(?:instructions?|prompts?|rules|guidelines|directions|context|everything(?:\s+above)?)\b/gi, cut)
    .replace(/\b(?:disregard|ignore|forget)\s+everything\s+(?:above|before|so far)\b/gi, cut)
    .replace(/\byou\s+are\s+(?:now|no longer)\b[^.\n]*/gi, cut)
    .replace(/\b(?:system|developer|hidden)\s+(?:prompt|message|instructions?)\b/gi, cut)
    .replace(/\b(?:reveal|print|show|repeat|leak)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+|initial\s+|hidden\s+)?(?:prompt|instructions?)\b/gi, cut)
    .replace(/\b(?:call|invoke|run|use|execute)\s+(?:the\s+)?(?:tool\s+|function\s+)?[`"']?(?:finish_redteam_session|evaluate_spoken_claim|reevaluate_claim|select_next_challenge|find_source_conflict|retrieve_source)\b[^.\n]*/gi, cut)
    .replace(/\bmark\s+(?:every|all|each)\s+claims?\b[^.\n]*/gi, cut)
    .replace(/\bnew\s+instructions?\s*:/gi, `${cut}:`);
}
