/*
 * panel.js — the VIVA control, injected into the page the student acted on.
 *
 * It lives in a shadow root so the page cannot style it and it cannot style
 * the page. It never reads the page: the only text it sends is what the
 * student typed, said, or had selected when they chose "Ask VIVA about this".
 * The line at the bottom of the card says exactly that, on screen, always.
 *
 * The reply comes back from /api/study/turn — the same endpoint the study
 * screen posts to — so a thought said here lands in the same record as a
 * thought said in the app. Nothing about tutoring is reimplemented here.
 */

if (!window.__vivaPanel) {
  window.__vivaPanel = true;

  const CSS = `
:host { all: initial; }
.card {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  width: 360px; max-width: calc(100vw - 40px); max-height: 70vh;
  display: flex; flex-direction: column; overflow: hidden;
  background: #0b0b0c; color: #f2f0ea; border: 1px solid #262a31; border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0,0,0,.55);
  font: 400 14px/1.55 ui-sans-serif, system-ui, sans-serif;
}
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #262a31; background: #131417; }
.mark { width: 8px; height: 8px; border-radius: 2px; background: #b8ff5a; flex: none; }
.title { font-weight: 600; letter-spacing: -.01em; }
.subject { color: #a7abb6; font-size: 12px; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
.x { all: unset; cursor: pointer; color: #a7abb6; padding: 2px 6px; border-radius: 6px; font-size: 16px; line-height: 1; }
.x:hover, .x:focus-visible { background: #262a31; color: #f2f0ea; outline: 2px solid #b8ff5a; outline-offset: 1px; }
.body { padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.compose { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px; flex: none; }
.reply:empty { display: none; }
.reply { background: #191b1f; border: 1px solid #262a31; border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; }
.quote { color: #d3d1c9; font: 400 12px/1.5 ui-monospace, Menlo, monospace; border-left: 2px solid #3a3f47; padding-left: 8px; margin-top: 8px; }
.said { color: #a7abb6; font-size: 12px; }
.said:empty { display: none; }
textarea {
  width: 100%; box-sizing: border-box; resize: vertical; min-height: 68px;
  background: #131417; color: #f2f0ea; border: 1px solid #262a31; border-radius: 8px; padding: 9px 10px;
  font: inherit;
}
textarea:focus-visible { outline: 2px solid #b8ff5a; outline-offset: 1px; border-color: #3a3f47; }
.row { display: flex; gap: 8px; align-items: center; }
/* Every colour rule below is written button.x, not .x: "all: unset" in the
   base rule has the same specificity as a bare class, so a plain .go lost its
   own background to it and both buttons rendered as naked text. */
button.act { all: unset; cursor: pointer; border-radius: 8px; padding: 9px 14px; font-weight: 600; font-size: 13px; text-align: center; box-sizing: border-box; }
button.go { background: #b8ff5a; color: #0b0b0c; flex: 1; }
button.go[disabled] { background: #3a3f47; color: #a7abb6; cursor: default; }
button.mic { background: #191b1f; color: #f2f0ea; border: 1px solid #262a31; }
button.mic.on { background: #ff8080; color: #0b0b0c; border-color: #ff8080; }
button.act:focus-visible { outline: 2px solid #b8ff5a; outline-offset: 2px; }
.note { padding: 9px 12px; border-top: 1px solid #262a31; color: #a7abb6; font-size: 11.5px; background: #131417; }
.err { color: #ff8080; }
`;

  let ui = null;
  const state = { subject: null, origin: "", kind: "typed", busy: false, rec: null };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function build() {
    const host = el("div");
    host.style.setProperty("all", "initial");
    const root = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];

    const card = el("div", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "VIVA");

    const head = el("div", "head");
    const subject = el("span", "subject");
    const close = el("button", "x", "×");
    close.setAttribute("aria-label", "Close VIVA");
    close.onclick = hide;
    head.append(el("span", "mark"), el("span", "title", "VIVA"), subject, close);

    const body = el("div", "body");
    const said = el("p", "said");
    const reply = el("div", "reply");
    reply.setAttribute("aria-live", "polite");
    const box = document.createElement("textarea");
    box.setAttribute("aria-label", "What are you thinking about this page?");
    box.placeholder = "Say what you think this is saying…";
    const row = el("div", "row");
    const mic = el("button", "act mic", "Hold to speak");
    const go = el("button", "act go", "Ask VIVA");
    row.append(mic, go);
    body.append(said, reply);
    const compose = el("div", "compose");
    compose.append(box, row);

    const note = el("p", "note");
    card.append(head, body, compose, note);
    root.append(card);
    document.documentElement.append(host);

    box.onkeydown = (e) => {
      if (e.key === "Escape") hide();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
    };
    go.onclick = ask;
    mic.onpointerdown = startRec;
    mic.onpointerup = stopRec;
    mic.onpointerleave = stopRec;

    ui = { host, card, subject, said, reply, box, mic, go, note };
    return ui;
  }

  const show = () => { if (ui) ui.host.style.display = ""; };
  const hide = () => { if (ui) ui.host.style.display = "none"; };

  function renderNote(extra) {
    ui.note.textContent =
      extra ||
      `Only what you write or say here leaves this page — it goes to ${state.origin} when you press Ask. VIVA is not reading this page.`;
  }

  function setBusy(busy, label) {
    state.busy = busy;
    ui.go.disabled = busy;
    ui.go.textContent = busy ? label || "Thinking…" : "Ask VIVA";
  }

  async function ask() {
    const text = ui.box.value.trim();
    if (!text || state.busy) return;
    setBusy(true);
    ui.said.textContent = `You said: ${text}`;
    ui.reply.replaceChildren();
    const res = await chrome.runtime
      .sendMessage({ type: "viva.panel.turn", subjectId: state.subject?.id || null, text, origin: state.kind })
      .catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      ui.reply.replaceChildren(el("span", "err", res?.error?.message || "VIVA did not answer. Open VIVA in a tab and try again."));
      return;
    }
    ui.box.value = "";
    state.kind = "typed";
    ui.reply.replaceChildren(el("div", null, res.reply));
    // The reply usually ends with the question already; showing it twice made
    // the card look like it was stuttering.
    if (res.question && !res.reply.includes(res.question)) ui.reply.append(el("div", "quote", res.question));
    for (const q of (res.citations || []).slice(0, 1)) ui.reply.append(el("div", "quote", `“${q}”`));
    if (res.band) ui.reply.append(el("div", "said", res.band.label));
  }

  /* ---- speaking -------------------------------------------------------
   * The panel hands VIVA a 16 kHz mono WAV, which is the only shape
   * /api/voice/transcribe accepts — see src/lib/audio/wav.ts for why (a
   * mislabelled sample rate got billed at six times the length). The encoder
   * below is that file's blobToWav16kMono, ported rather than imported: a
   * content script cannot import the app TypeScript and this extension
   * deliberately has no build step.
   * ponytail: ~35 duplicated lines; delete them the day the panel can import
   * from the app bundle.
   */

  async function blobToWav16kMono(blob) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
      const src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start(0);
      const ch = (await off.startRendering()).getChannelData(0);
      const buf = new ArrayBuffer(44 + ch.length * 2);
      const v = new DataView(buf);
      const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      str(0, "RIFF"); v.setUint32(4, 36 + ch.length * 2, true); str(8, "WAVE");
      str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      str(36, "data"); v.setUint32(40, ch.length * 2, true);
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return { buf, ms: Math.round((ch.length / 16000) * 1000) };
    } finally {
      void ctx.close().catch(() => {});
    }
  }

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function startRec() {
    if (state.rec || state.busy) return;
    renderNote(`Recording. The audio goes to ${state.origin} to be transcribed, and nothing else does.`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const parts = [];
      rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        state.rec = null;
        ui.mic.classList.remove("on");
        ui.mic.textContent = "Hold to speak";
        renderNote();
        await transcribe(new Blob(parts, { type: rec.mimeType }));
      };
      rec.start();
      state.rec = rec;
      ui.mic.classList.add("on");
      ui.mic.textContent = "Listening…";
    } catch {
      renderNote("This page would not give VIVA the microphone. Type it instead.");
    }
  }

  function stopRec() {
    if (state.rec && state.rec.state === "recording") state.rec.stop();
  }

  async function transcribe(blob) {
    setBusy(true, "Transcribing…");
    try {
      const { buf, ms } = await blobToWav16kMono(blob);
      if (ms < 300) { setBusy(false); renderNote("That was too short to hear. Hold the button while you talk."); return; }
      const res = await chrome.runtime
        .sendMessage({ type: "viva.panel.transcribe", wav: toBase64(buf), subjectId: state.subject?.id || null })
        .catch(() => null);
      setBusy(false);
      if (!res?.ok) { renderNote(res?.error?.message || "VIVA could not hear that. Type it instead."); return; }
      ui.box.value = res.text;
      state.kind = "voice";
      ui.box.focus();
    } catch {
      setBusy(false);
      renderNote("VIVA could not read that recording. Type it instead.");
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "viva.panel.open") return false;
    if (!ui) build();
    show();
    state.subject = msg.subject || null;
    state.origin = msg.origin || "";
    state.kind = "typed";
    ui.subject.textContent = state.subject ? state.subject.title : "your current subject";
    ui.subject.title = state.subject ? state.subject.title : "No subject was built from this page yet";
    if (msg.selection) ui.box.value = msg.selection;
    renderNote();
    ui.box.focus();
    return false;
  });
}
