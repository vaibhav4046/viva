/*
 * Records a captioned walkthrough of the review room on the TYPED path.
 *
 * This is NOT the Voice Agent demo. A headless browser has no microphone and
 * this environment has no AssemblyAI credentials, so the recording shows the
 * screen, the claim engine, the Defensibility Map, the interruption and the
 * correction on typed input, and says so in its first caption and its last.
 * The real recording — voice, barge-in, the agent's speech stopping — is
 * scripted in docs/submission/VIDEO-SCRIPT.md and needs a person and a key.
 *
 * Usage: node scripts/record-typed-walkthrough.mjs [http://localhost:3210]
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3210";
const OUT = path.resolve("docs/submission");
const RAW = path.join(OUT, "video-raw");
fs.rmSync(RAW, { recursive: true, force: true });
fs.mkdirSync(RAW, { recursive: true });

const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: RAW, size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();

const caption = async (text, ms = 2600) => {
  await page.evaluate((t) => {
    let el = document.getElementById("__cap");
    if (!el) {
      el = document.createElement("div");
      el.id = "__cap";
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:820px;padding:10px 18px;background:#f1ebde;color:#201e19;font:500 20px/1.35 Georgia,serif;border:1px solid #201e19;z-index:99999;text-align:center";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await page.waitForTimeout(ms);
};
const typeSlow = async (text) => {
  const input = page.getByTestId("typed-input");
  await input.click();
  await input.pressSequentially(text, { delay: 32 });
  await page.waitForTimeout(350);
  await input.press("Enter");
};

await page.goto(`${BASE}/redteam`);
await page.getByRole("heading", { level: 1 }).waitFor();
await caption("Typed-mode walkthrough. The voice path needs a microphone and an AssemblyAI key; this shows the screen and the checks.", 4200);
await page.getByTestId("begin").click();
await page.getByTestId("room").waitFor();
await caption("Sample material. VIVA opens with a question built from the document's own sentence.", 3600);
await page.getByRole("button", { name: "Type instead" }).click();
await caption("You make a claim.", 1400);
await typeSlow("We automatically fail over to a replica.");
await page.locator('[data-testid="band-CONTRADICTED"] [data-testid="claim-1"]').waitFor();
await caption("Contradicted. The document's own sentence is marked on the left, and the claim lands on the map.", 4200);
await caption("You cut VIVA off mid-explanation.", 1800);
await page.getByTestId("typed-interrupt").click();
await page.waitForTimeout(1600);
await caption("The claim is now waiting for your correction.", 2600);
await typeSlow("Wait. I meant manual failover.");
await page.locator('[data-testid="band-SUPPORTED"] [data-testid="claim-1"]').waitFor();
await caption("The document is searched again. Same claim, new verdict: Contradicted → Supported.", 4400);
await caption("Now a claim the document says nothing about.", 1800);
await typeSlow("We guarantee GDPR compliance and SOC 2 certification for all customer data.");
await page.locator('[data-testid="band-UNSUPPORTED"] [data-testid="claim-2"]').waitFor();
await caption("Unsupported: no passage was found, and none is cited.", 3600);
await page.locator("details.rt-timeline summary").click();
await page.waitForTimeout(400);
await caption("Every step is on the timeline: question, claim, verdict, interruption, correction.", 3800);
await page.getByTestId("finish").click();
await page.getByTestId("report").waitFor();
await caption("The Defensibility Report. Sections you can act on, and no score.", 4200);
await page.evaluate(() => window.scrollTo({ top: 520, behavior: "instant" }));
await caption("This was the typed path, not the Voice Agent.", 3000);

const video = page.video();
await ctx.close();
const src = await video.path();
fs.copyFileSync(src, path.join(OUT, "demo-typed-walkthrough.webm"));
fs.rmSync(RAW, { recursive: true, force: true });
await browser.close();
console.log("wrote docs/submission/demo-typed-walkthrough.webm", (fs.statSync(path.join(OUT, "demo-typed-walkthrough.webm")).size / 1e6).toFixed(1) + " MB");
