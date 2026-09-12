/**
 * HTML in, readable passages out.
 *
 * One extractor, two callers: the corpus seeder reading an OpenStax section,
 * and a student pasting a URL. Both need the same thing — the prose a person
 * would read, with the heading it sat under, and nothing from the navigation.
 *
 * No parser dependency. Regex over HTML is wrong for anything that has to be
 * correct about structure; this only has to be right about which runs of text
 * are prose, and it fails safe: an element it cannot understand contributes
 * nothing rather than garbage. If a page yields too little, the caller says so
 * instead of guessing at what the page said.
 */

export type ReadableSection = { heading?: string; text: string };
export type Readable = { title: string | null; sections: ReadableSection[]; chars: number };

/** Comments and the two elements whose contents are code, not prose. */
const DROP_CODE = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>/gi;

/**
 * Every tag reduced to `<tag>` or `</tag>`, attributes gone.
 *
 * This exists because of one bug with a visible cost. Wikipedia stores parser
 * metadata in attributes — `<span data-mw='{"parts":[{"template":...">"}]}'>`
 * — and any `<[^>]*>` stops at the first `>` INSIDE that quoted JSON, so the
 * rest of the attribute leaked into the page as text. The first passage of a
 * subject built from a Wikipedia article opened with `{{Cite web |title=...`
 * before it said anything about photosynthesis. A scanner that knows a quote
 * from a bracket costs twenty lines and removes the whole class of it.
 */
function stripAttributes(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    let j = lt + 1;
    let quote: string | null = null;
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j += 1;
    }
    const inner = html.slice(lt + 1, j);
    const name = /^\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(inner);
    out += name ? `<${inner.startsWith("/") ? "/" : ""}${name[1].toLowerCase()}>` : " ";
    i = j + 1;
  }
  return out;
}

/** Footnote markers a reader skips: [12], [ note 1 ], [ citation needed ]. */
const FOOTNOTE = /\[\s*(?:\d{1,3}|note\s*\d{1,3}|citation needed|edit|a|b|c)\s*\]/gi;

/** Blocks whose text is never the article. Dropped whole, tag and content. */
const DROP_ELEMENTS =
  /<(script|style|noscript|svg|iframe|form|nav|aside|footer|header|figure|figcaption|table|math|button|select|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Self-closing or unclosed versions of the same, plus comments. */
const DROP_STRAY = /<!--[\s\S]*?-->|<(?:script|style|svg|math|br|hr|img|input|source|track)\b[^>]*\/?>/gi;

/** Prose carriers, in document order, with headings so provenance survives. */
const BLOCK = /<(h1|h2|h3|h4|p|li|dd|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", deg: "°",
  times: "×", divide: "÷", minus: "−", plusmn: "±", micro: "µ",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", pi: "π",
  sigma: "σ", mu: "μ", lambda: "λ", theta: "θ", omega: "ω",
  le: "≤", ge: "≥", ne: "≠", rarr: "→", larr: "←", harr: "↔",
  copy: "©", reg: "®", trade: "™", sup2: "²", sup3: "³", frac12: "½",
  eacute: "é", egrave: "è", uuml: "ü", ouml: "ö", auml: "ä", ccedil: "ç",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]{1,10});/gi, (m, name: string) => NAMED[name.toLowerCase()] ?? m);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(code);
  } catch {
    return " ";
  }
}

/** Attributes are already gone by here, so a bare tag strip is safe. */
function plain(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " "))
    .replace(FOOTNOTE, "")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The main content when the page marks it, the whole body when it does not.
 *
 * ponytail: first <article>/<main> wins. A page with several articles (a blog
 * index) gives us the first one, which is the wrong answer for an index page
 * and the right one everywhere else. Upgrade path is a density heuristic.
 */
function mainRegion(html: string): string {
  for (const tag of ["article", "main"]) {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(html);
    if (m && m[1].length > 500) return m[1];
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  return body ? body[1] : html;
}

function documentTitle(html: string): string | null {
  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (t) {
    const clean = plain(t[1]).replace(/\s*[|·—–-]\s*[^|·—–-]{2,40}$/, "").trim();
    if (clean.length >= 2) return clean.slice(0, 120);
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  const heading = h1 ? plain(h1[1]) : "";
  return heading.length >= 2 ? heading.slice(0, 120) : null;
}

/** A paragraph shorter than this is navigation, a caption or a button label. */
const MIN_PARAGRAPH = 60;

export function extractReadable(raw: string): Readable {
  const html = stripAttributes(raw.replace(DROP_CODE, " "));
  const title = documentTitle(html);
  const cleaned = mainRegion(html).replace(DROP_ELEMENTS, " ").replace(DROP_STRAY, " ");

  const sections: ReadableSection[] = [];
  let heading: string | undefined;
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join(" ").trim();
    if (text.length >= MIN_PARAGRAPH) sections.push(heading ? { heading, text } : { text });
    buffer = [];
  };

  for (const match of cleaned.matchAll(BLOCK)) {
    const tag = match[1].toLowerCase();
    const text = plain(match[2]);
    if (!text) continue;
    if (tag.startsWith("h")) {
      flush();
      heading = text.slice(0, 80);
      continue;
    }
    if (text.length < MIN_PARAGRAPH) continue;
    buffer.push(text);
  }
  flush();

  const chars = sections.reduce((n, s) => n + s.text.length, 0);
  return { title, sections, chars };
}
