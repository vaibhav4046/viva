/*
 * popup.js — two buttons and an honest label.
 *
 * The popup never reads a page itself; it asks the service worker to, and only
 * on a click. Progress comes from chrome.storage rather than a message
 * channel, because building a subject outlives this popup: close it mid-build,
 * open it again, and the lines are still there.
 */

const ORIGINS = ["http://localhost:3000", "https://viva-five-murex.vercel.app"];

const $ = (id) => document.getElementById(id);
const log = $("log");

function say(text, cls) {
  log.classList.add("on");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

function reset() {
  log.replaceChildren();
  log.classList.remove("on");
}

/** Render a capture record from storage. Called on open and on every change. */
let shownLines = 0;
let shownStatus = null;
function render(capture) {
  if (!capture) return;
  if (capture.status !== shownStatus) { shownStatus = capture.status; }
  for (const line of (capture.lines || []).slice(shownLines)) say(line);
  shownLines = (capture.lines || []).length;
  if (capture.status === "error" && capture.error) {
    say(capture.error.message, "err");
    $("capture").disabled = false;
    $("capture").textContent = "Read this page into VIVA";
  }
  if (capture.status === "done" && capture.subject) {
    const s = capture.subject;
    say(`${s.title} is ready · ${s.concepts} concepts · ${s.questions} questions`, "ok");
    if (s.storageNote) say(s.storageNote);
    const open = document.createElement("a");
    open.href = "#";
    open.textContent = "Open it in VIVA →";
    open.onclick = async (e) => {
      e.preventDefault();
      const origin = $("origin").value;
      await chrome.tabs.create({ url: origin + (capture.redirect || "/study") });
    };
    log.append(open);
    $("capture").disabled = false;
    $("capture").textContent = "Read this page into VIVA";
  }
}

async function init() {
  const sel = $("origin");
  for (const o of ORIGINS) {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o.replace(/^https?:\/\//, "");
    sel.append(opt);
  }
  const { origin } = await chrome.storage.local.get("origin");
  sel.value = ORIGINS.includes(origin) ? origin : ORIGINS[ORIGINS.length - 1];
  sel.onchange = () => chrome.storage.local.set({ origin: sel.value });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("page").textContent = tab?.title || tab?.url || "This page";
  $("page").title = tab?.url || "";

  $("capture").onclick = async () => {
    reset();
    shownLines = 0;
    $("capture").disabled = true;
    $("capture").textContent = "Reading…";
    say(`Sending this page to ${sel.value}`);
    const res = await chrome.runtime.sendMessage({ type: "viva.capture" }).catch(() => null);
    if (!res?.ok) {
      say(res?.message || "VIVA could not read this page.", "err");
      $("capture").disabled = false;
      $("capture").textContent = "Read this page into VIVA";
      return;
    }
    const p = res.page;
    say(`Read ${p.chars.toLocaleString()} characters${p.shape === "conversation" ? " of the conversation" : ""}${p.trimmed ? " (trimmed)" : ""}.`);
  };

  $("panel").onclick = async () => {
    const res = await chrome.runtime.sendMessage({ type: "viva.openPanel" }).catch(() => null);
    if (!res?.ok) { say(res?.message || "VIVA cannot open on this page.", "err"); return; }
    window.close();
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.capture) render(changes.capture.newValue);
  });

  // A build outlives this popup. Close it half way through, open it again, and
  // the lines are still here — as long as they are recent enough to be about
  // the page in front of you.
  const { capture } = await chrome.storage.local.get("capture");
  if (capture && Date.now() - (capture.at || 0) < 600000) {
    if (capture.status === "running") {
      $("capture").disabled = true;
      $("capture").textContent = "Reading…";
    }
    say(`${capture.title}`);
    render(capture);
  }
}

void init();
