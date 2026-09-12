/*
 * extract.js — read the page the student just acted on, and nothing else.
 *
 * Injected by background.js with chrome.scripting.executeScript, which only
 * ever happens after a click on the VIVA button or the context menu. It is
 * never a declared content script, so it does not run on page load, on any
 * site, ever. The completion value of the final expression is what the
 * service worker receives.
 *
 * Two shapes of page, one output:
 *   - an AI chat (Gemini, NotebookLM, Claude, ChatGPT): the visible turns,
 *     labelled, in order;
 *   - anything else: the readable block (article/main/densest container),
 *     with navigation, asides and scripts removed.
 */

/** Hard cap. /api/subjects/create slices at 200k; stopping early keeps the
 *  build honest about how much of the page it actually read. */
var VIVA_MAX_CHARS = 100000;

/** Elements that are never study material, wherever they appear. */
var VIVA_JUNK = "script,style,noscript,nav,header,footer,aside,form,button,svg,iframe,[aria-hidden='true'],[role='navigation'],[role='banner'],[role='contentinfo']";

/**
 * The turn selectors for the four AI surfaces the student named, keyed by the
 * hostname suffix they serve from. Each entry is tried in order; the first
 * that finds turns wins. These WILL rot — they are somebody else's DOM — so a
 * miss falls through to readable extraction rather than failing.
 * @type {{host: string, turns: string, role?: (el: Element) => string|null}[]}
 */
var VIVA_CHAT_SITES = [
  {
    host: "chatgpt.com",
    turns: "[data-message-author-role]",
    role: (el) => el.getAttribute("data-message-author-role"),
  },
  {
    host: "chat.openai.com",
    turns: "[data-message-author-role]",
    role: (el) => el.getAttribute("data-message-author-role"),
  },
  {
    host: "claude.ai",
    turns: "[data-testid='user-message'],.font-claude-response,.font-claude-message",
    role: (el) => (el.getAttribute("data-testid") === "user-message" ? "user" : "assistant"),
  },
  {
    host: "gemini.google.com",
    turns: "user-query,model-response",
    role: (el) => (el.tagName.toLowerCase() === "user-query" ? "user" : "assistant"),
  },
  {
    host: "notebooklm.google.com",
    turns: "chat-message,.chat-message,.to-user-container,.from-user-container",
    role: (el) => (/from-user/.test(el.className || "") ? "user" : "assistant"),
  },
];

/**
 * Collapse a scraped blob into something a person would recognise as text.
 * Blank-line runs become one, trailing spaces go, and a line repeated straight
 * after itself (menus and sticky headers do this constantly) is dropped once.
 * @param {string} raw
 * @returns {string}
 */
function tidy(raw) {
  const lines = String(raw || "").replace(/\r/g, "").split("\n");
  /** @type {string[]} */
  const out = [];
  for (const line of lines) {
    const t = line.replace(/[ \t\u00a0]+/g, " ").trim();
    if (!t) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (out.length && out[out.length - 1] === t) continue;
    out.push(t);
  }
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * Pick the container that is actually the article.
 *
 * Length alone picks <body> on every page with a sidebar, so length is
 * discounted by link density: a nav column is nearly all anchor text and
 * scores near zero, a paragraph of prose keeps almost all of its length.
 * @template {{text: string, linkChars: number}} T
 * @param {T[]} candidates
 * @returns {T | null}
 */
function pickBest(candidates) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const len = (c.text || "").length;
    if (len < 200) continue;
    const density = Math.min(1, (c.linkChars || 0) / len);
    const score = len * (1 - density);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/**
 * Label and join chat turns into one transcript.
 * Empty turns are dropped; a turn is capped so one enormous code block cannot
 * eat the whole budget and hide the rest of the conversation.
 * @param {{role: string|null, text: string}[]} turns
 * @returns {string}
 */
function joinTurns(turns) {
  const parts = [];
  for (const t of turns) {
    const text = tidy(t.text).slice(0, 8000);
    if (!text) continue;
    const label = t.role === "user" ? "Me" : t.role === "assistant" || t.role === "model" ? "Assistant" : null;
    parts.push(label ? `${label}: ${text}` : text);
  }
  return parts.join("\n\n");
}

/** Visible text of an element, with the junk stripped first. @param {Element} el */
function vivaText(el) {
  const clone = /** @type {HTMLElement} */ (el.cloneNode(true));
  clone.querySelectorAll(VIVA_JUNK).forEach((n) => n.remove());
  return clone.innerText || clone.textContent || "";
}

/** How many characters inside an element are anchor text, for the discount. @param {Element} el */
function vivaLinkChars(el) {
  let n = 0;
  el.querySelectorAll("a").forEach((a) => {
    n += (/** @type {HTMLElement} */ (a).innerText || a.textContent || "").length;
  });
  return n;
}

(function () {
  const host = location.hostname;
  const site = VIVA_CHAT_SITES.find((s) => host === s.host || host.endsWith("." + s.host));

  let text = "";
  let shape = "page";

  if (site) {
    const nodes = Array.from(document.querySelectorAll(site.turns));
    if (nodes.length) {
      text = joinTurns(nodes.map((el) => ({ role: site.role ? site.role(el) : null, text: vivaText(el) })));
      shape = "conversation";
    }
  }

  if (!text) {
    const seen = new Set();
    const candidates = [];
    for (const sel of ["article", "main", "[role='main']", "#content", ".content", ".post", ".markdown-body", "body"]) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (seen.has(el)) continue;
        seen.add(el);
        candidates.push({ text: tidy(vivaText(el)), linkChars: vivaLinkChars(el) });
      }
    }
    const best = pickBest(candidates);
    text = best ? best.text : tidy(document.body ? vivaText(document.body) : "");
  }

  const full = text.length;
  return {
    ok: text.trim().length >= 200,
    title: (document.title || location.hostname || "This page").trim().slice(0, 200),
    url: location.href.split("#")[0].slice(0, 500),
    shape,
    text: text.slice(0, VIVA_MAX_CHARS),
    chars: Math.min(full, VIVA_MAX_CHARS),
    trimmed: full > VIVA_MAX_CHARS,
  };
})();
