/*
 * background.js — the service worker. It decides nothing about content; it
 * moves three things between three places:
 *
 *   the page the student acted on  ->  extract.js  ->  the VIVA tab (bridge.js)
 *
 * Reading a page ONLY ever happens inside `withActiveTab`, which runs after a
 * toolbar click or a context-menu click and nowhere else. There is no
 * declared content script and no host permission for any site but VIVA, so
 * there is no code path in this extension that can read a page the student
 * did not act on.
 */

/** The two origins VIVA is served from. Self-hosting means editing this list
 *  and the matching `host_permissions` in manifest.json — a host permission
 *  cannot be conjured at runtime, and should not be. */
const ORIGINS = ["http://localhost:3000", "https://viva-five-murex.vercel.app"];

const get = (key, fallback) => chrome.storage.local.get(key).then((v) => v[key] ?? fallback);

async function vivaOrigin() {
  const saved = await get("origin", null);
  return ORIGINS.includes(saved) ? saved : ORIGINS[ORIGINS.length - 1];
}

/** Wait for a tab to stop loading. Injecting into a loading tab silently
 *  loses the script when the document is replaced. */
function whenComplete(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") return resolve();
      const onUpdated = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    }).catch(() => resolve());
  });
}

/**
 * A VIVA tab with bridge.js live in it. Reuses one the student already has
 * open; otherwise opens one in the background, without stealing focus.
 * @returns {Promise<{tabId: number, origin: string}>}
 */
async function ensureBridge() {
  const origin = await vivaOrigin();
  const open = await chrome.tabs.query({ url: `${origin}/*` });
  let tab = open[0];
  if (!tab) tab = await chrome.tabs.create({ url: `${origin}/study`, active: false });
  await whenComplete(tab.id);
  const alive = await chrome.tabs.sendMessage(tab.id, { type: "viva.ping" }).catch(() => null);
  if (!alive) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] });
  }
  return { tabId: tab.id, origin };
}

/** The active tab, and the one gesture-scoped read of it this extension does. */
async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No page is open here.");
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["extract.js"] });
  return { tab, page: result };
}

async function rememberSubject(url, subject) {
  const subjects = await get("subjects", {});
  subjects[url] = { id: subject.id, title: subject.title };
  const keys = Object.keys(subjects);
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete subjects[k];
  await chrome.storage.local.set({ subjects });
}

/** Capture: read this page, hand it to the VIVA tab, let the bridge stream. */
async function capture() {
  const { page } = await readActiveTab();
  if (!page) throw new Error("VIVA cannot read this kind of page.");
  if (!page.ok) throw new Error("There is not enough text on this page to study — VIVA needs a few paragraphs.");
  const { tabId } = await ensureBridge();
  // The bridge owns the capture record end to end — one writer, no races.
  await chrome.tabs.sendMessage(tabId, {
    type: "viva.create",
    title: page.title, text: page.text, url: page.url,
    chars: page.chars, shape: page.shape, trimmed: page.trimmed,
  });
  return page;
}

/** Put the VIVA control on the page, and hand it the selection if there is one. */
async function openPanel(selection) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["panel.js"] });
  const subjects = await get("subjects", {});
  const url = (tab.url || "").split("#")[0];
  await chrome.tabs.sendMessage(tab.id, {
    type: "viva.panel.open",
    selection: selection || "",
    subject: subjects[url] || null,
    origin: await vivaOrigin(),
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "viva-ask", title: "Ask VIVA about this", contexts: ["selection"] });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "viva-ask") void openPanel(String(info.selectionText || "").slice(0, 4000));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // From the popup.
  if (msg?.type === "viva.capture") {
    capture().then((page) => sendResponse({ ok: true, page }))
      .catch((e) => sendResponse({ ok: false, message: e.message || "That did not work." }));
    return true;
  }
  if (msg?.type === "viva.openPanel") {
    openPanel(msg.selection).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, message: e.message || "VIVA cannot open on this page." }));
    return true;
  }
  // From the injected panel: relay one study turn through the VIVA tab.
  if (msg?.type === "viva.panel.turn" || msg?.type === "viva.panel.transcribe") {
    const forward = msg.type === "viva.panel.turn"
      ? { type: "viva.turn", subjectId: msg.subjectId, text: msg.text, origin: msg.origin }
      : { type: "viva.transcribe", subjectId: msg.subjectId, wav: msg.wav };
    ensureBridge()
      .then(({ tabId }) => chrome.tabs.sendMessage(tabId, forward))
      .then((r) => sendResponse(r || { ok: false, error: { message: "VIVA did not answer." } }))
      .catch(() => sendResponse({ ok: false, error: { message: "VIVA is not open in this browser." } }));
    return true;
  }
  return false;
});

// A finished capture is remembered against the page it came from, so the
// panel on that page knows which subject it is talking about.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.capture) return;
  const c = changes.capture.newValue;
  if (c?.status === "done" && c.subject && c.url) void rememberSubject(c.url, c.subject);
});
