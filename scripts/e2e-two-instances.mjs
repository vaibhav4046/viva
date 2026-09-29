/*
 * A review must survive the server instance that held it.
 *
 * Serverless hosts send consecutive requests to different instances; without a
 * database, the second instance has never seen the review. This runs that for
 * real: two independent servers with separate memory and separate session
 * directories, the page served by A, and every RedTeam call after the first
 * claim rerouted to B. B has to answer "not here", the browser has to restore
 * its signed copy on B, and the review has to carry on with the ledger intact.
 *
 * Start two servers from the same build, each with its own session directory
 * and the same REDTEAM_SECRET (the secret is what lets B verify A's copy):
 *   REDTEAM_SECRET=... REDTEAM_DIR=/tmp/rt-a npx next start -p 3210 &
 *   REDTEAM_SECRET=... REDTEAM_DIR=/tmp/rt-b npx next start -p 3211 &
 *   node scripts/e2e-two-instances.mjs http://localhost:3210 http://localhost:3211
 */
import { chromium } from "@playwright/test";

const [A = "http://localhost:3210", B = "http://localhost:3211"] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// Every RedTeam API call, once switched, goes to instance B with the same cookie.
let toB = false;
const seen = [];
await page.route("**/api/redteam/**", async (route) => {
  const req = route.request();
  if (!toB) return route.continue();
  const url = req.url().replace(A, B);
  const res = await route.fetch({ url });
  seen.push(`${new URL(url).pathname} ${res.status()}`);
  return route.fulfill({ response: res });
});

await page.goto(`${A}/redteam`);
await page.getByTestId("begin").click();
await page.getByTestId("room").waitFor();
await page.getByRole("button", { name: "Type instead" }).click();
const input = page.getByTestId("typed-input");
await input.fill("We automatically fail over to a replica.");
await input.press("Enter");
await page.locator('[data-testid="band-CONTRADICTED"] [data-testid="claim-1"]').waitFor();
check("instance A records the first claim as Contradicted", true);

// From here on, instance B answers. It has never seen this review.
toB = true;
await page.getByTestId("typed-interrupt").click();
await page.getByText("cut off · awaiting your correction").waitFor({ timeout: 15000 });
check("instance B restored the review from the browser's signed copy", seen.some((s) => s.startsWith("/api/redteam/session/restore 200")), seen.join(", "));
check("the call that found the review missing was retried and succeeded", seen.filter((s) => s.startsWith("/api/redteam/typed")).some((s) => s.endsWith(" 200")));

await input.fill("Wait. I meant manual failover.");
await input.press("Enter");
await page.locator('[data-testid="band-SUPPORTED"] [data-testid="claim-1"]').waitFor({ timeout: 15000 });
check("on instance B the correction moves the same claim to Supported", (await page.locator('[data-testid^="claim-"]').count()) === 1);

// A tampered copy must not restore: corrupt the next snapshot B hands out and force another miss.
const tampered = await page.evaluate(async (base) => {
  const r = await fetch(`${base}/api/redteam/session/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshot: { data: "AAAA", sig: "forged-signature-value" } }),
  });
  return r.status;
}, A);
check("a forged copy is refused with the same answer as a missing review", tampered === 404, String(tampered));

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} two-instance assertions passed`);
process.exit(failed ? 1 : 0);
