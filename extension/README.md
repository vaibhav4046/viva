# VIVA in the browser

VIVA works on the page you are already reading. Three things, no copy-paste:

1. **Read this page into VIVA.** One click turns the page in front of you into a subject —
   the readable article on a course site, or the visible conversation on Gemini, NotebookLM,
   Claude or ChatGPT. It goes to `POST /api/subjects/create`, the same endpoint the paste box
   uses, and you watch it build line by line in the popup.
2. **Talk about it in place.** A small VIVA card on the page. Say or type what you think the
   page is saying; it posts to `POST /api/study/turn` and the Socratic reply, the citation and
   the mastery band come back in the card. It is the same turn as one taken inside the app, in
   the same record.
3. **Ask about a passage.** Select text, right-click, "Ask VIVA about this". The card opens
   with the selection already in it.

## Load it unpacked

```
1. npm run dev                     # VIVA on http://localhost:3000
2. chrome://extensions
3. Turn on "Developer mode" (top right)
4. "Load unpacked" -> select this extension/ folder
5. Open the VIVA icon and pick the destination (localhost or the deployed app)
```

Nothing to build. There is no bundler, no TypeScript step and no `node_modules` here — plain
JavaScript with JSDoc types, because the repo's `tsc` is configured for the Next app (its
`include` is `**/*.ts`, so an `extension/*.ts` file would be swept into `npm run typecheck`
with the wrong libs and no `chrome` types). A build step you have to remember is a build step
that goes stale.

Run the extractor's checks with `node extension/extract.selftest.mjs`.

## Permissions, and why each one is there

| Permission | Why |
|---|---|
| `activeTab` | Read the page you acted on, and only that one. Granted by Chrome at the moment you click the VIVA icon or the context-menu item, for that tab only, and it lapses when the tab navigates. |
| `scripting` | Inject the extractor and the card into that tab, and the bridge into your VIVA tab. Required to use `activeTab` at all. |
| `contextMenus` | The "Ask VIVA about this" item on selected text. |
| `storage` | Remember which VIVA you are sending to, which subject came from which page, and the progress of a build that outlives the popup. Local to this browser. |
| `host_permissions: http://localhost:3000/*`, `https://viva-five-murex.vercel.app/*` | VIVA itself, and nothing else. This is what lets the extension talk to your own VIVA tab. |

**There is no host permission for any other site.** Not `<all_urls>`, not `https://*/*`, not
Gemini or ChatGPT or your university's VLE. The extension is structurally incapable of reading
a page you did not act on: with no declared content script and no host permission, an attempt
to read an arbitrary page without your click is refused by Chrome —

```
Cannot access contents of the page.
Extension manifest must request permission to access the respective host.
```

— which is the actual error from the check in this repo's verification run, not a promise.

What leaves your browser, and when:

- **Read this page**: the page's text, title and address, once, when you press the button. The
  popup says so above the button, and afterwards tells you how many characters went.
- **Talk about this page**: only what you type or say into the card. The card says so, on
  screen, the whole time it is open. It does not read the page it is sitting on.
- **Hold to speak**: the audio of that clip, to be transcribed, and nothing else.
- Never anything in the background. Nothing at page load. No other tab.

## Identity

The extension holds no token, no key, no credential of any kind.

Every request is made by `bridge.js`, which is injected into *your VIVA tab*, so the request is
same-origin and carries your own `viva_did` cookie exactly as a click inside the app would.
The extension is a courier: it hands the VIVA page a payload and carries the answer back. A
page on another site never sees a VIVA response, and no VIVA credential ever exists outside
the VIVA origin.

This is deliberately **not** a second identity mechanism — it is no identity mechanism, reusing
the one the app already has through the origin that owns it. It is also why there is no new
API route: with no cross-origin call there is no CORS problem to solve, and nothing in
`src/` was touched to make this work.

### Converging with MCP pairing

The MCP pairing flow now exists in this repo: `/connect` mints a ten-minute code from the
cookie (`POST /api/mcp/pair`), an assistant exchanges it for a thirty-day key
(`viva-key-…`), and `src/lib/mcp/auth.ts` turns that key back into a user id. It reaches the
product the same way this extension does — `src/lib/mcp/api.ts` is a *client* of
`/api/subjects/create` and `/api/study/turn`, adding a cookie it rebuilds from the verified
token, re-implementing nothing.

The extension does not hold one of those keys today, for one concrete reason: only the server
can turn a key back into a cookie, and `resolveIdentity` still reads the cookie and nothing
else — it has no bearer path. So a paired key would buy the extension nothing that the
student's own tab does not already give it, at the cost of a thirty-day credential sitting in
extension storage.

Two ways to converge, in preference order:

1. **Teach `resolveIdentity` the bearer.** Roughly: if there is no `viva_did` cookie, read
   `Authorization`, run it through `readToken`/`userIdFor` from `src/lib/mcp/auth.ts`, and
   return that identity. Then `bridge.js` collapses — the same two `fetch` calls move into the
   service worker with an `Authorization` header (an extension service worker is not CORS-gated
   for hosts in `host_permissions`, so no CORS work is needed), the VIVA tab stops being
   required, and the extension gains a normal pairing screen. This is the change to make.
2. **Speak MCP JSON-RPC** to `POST /api/mcp` — `add_subject_from_notes` and `tell_viva` are
   already the two capabilities this extension needs, and this works today with no server
   change at all. The reason it is second: the tool results are shaped for an assistant to read
   aloud, so the popup loses the streamed build progress and the card loses the structured
   reply, citation and band it renders now.

Either way the change is confined to `bridge.js`. That is why the transport lives behind one
file.

## Limits

- **The VIVA origins are fixed in `manifest.json`.** Self-hosting elsewhere means editing
  `host_permissions` and the `ORIGINS` array in `background.js` and `popup.js`. A host
  permission cannot be invented at runtime, and an extension that asks for `https://*/*` so it
  can be pointed anywhere has given itself the run of the web.
- **You need a VIVA tab.** If none is open the extension opens one in the background. If VIVA
  is not running at the selected destination, the card says so instead of hanging.
- **The AI-chat selectors are somebody else's DOM** and will rot. When they do, the extractor
  falls back to reading the page as an article rather than failing — you get the conversation
  as flat text instead of labelled turns.
- **Chrome only.** Manifest V3 with `chrome.*` APIs; Firefox needs a `browser.*` shim and its
  own manifest key.
- **Pages Chrome will not let any extension touch** — `chrome://` pages, the Web Store, PDFs in
  the built-in viewer — cannot be read, and the popup says so.
- **Dictation needs the page's microphone.** The card records in the page it is sitting on, so
  the microphone prompt belongs to that site; if the site denies it, type instead. The audio
  goes to VIVA's own `/api/voice/transcribe`, never to the page and never to a third party.
