/*
 * Accessibility audit of every state of the review room (axe-core, WCAG 2 A/AA),
 * on desktop and phone widths. tests/a11y/*.spec.ts covers the static route; this
 * covers the states a route load never reaches: a room with claims in every band,
 * an open timeline, a cut-off claim, the report.
 *
 * Usage: node scripts/axe-redteam.mjs [http://localhost:3210]
 */
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE = process.argv[2] ?? "http://localhost:3210";
const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
let failed = 0;

async function audit(page, label) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const bad = r.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
  const minor = r.violations.filter((v) => !["serious", "critical"].includes(v.impact ?? ""));
  console.log(`${bad.length ? "FAIL" : "PASS"}  ${label}${bad.length ? "  — " + bad.map((v) => `${v.id} x${v.nodes.length}`).join(", ") : ""}${minor.length ? `  (minor: ${minor.map((v) => v.id).join(", ")})` : ""}`);
  for (const v of bad) for (const n of v.nodes.slice(0, 3)) console.log(`      ${n.target.join(" ")}  ${n.failureSummary?.split("\n")[1] ?? ""}`);
  if (bad.length) failed += 1;
}

async function begin(page) {
  for (let i = 0; i < 8; i++) {
    await page.getByTestId("begin").click();
    const ok = await page.getByTestId("room").waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
    if (ok) return;
    await page.waitForTimeout(7000);
  }
  throw new Error("could not begin");
}
async function type(page, text) {
  await page.getByTestId("typed-input").fill(text);
  await page.getByTestId("typed-input").press("Enter");
  await page.waitForTimeout(400);
}

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/redteam`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await audit(page, `${name}: setup`);
  await page.getByTestId("source-paste").check();
  await audit(page, `${name}: setup, paste form`);
  await page.getByTestId("source-paste").uncheck().catch(() => {});
  await page.getByRole("radio", { name: /Sample technical design/ }).check();
  await begin(page);
  await audit(page, `${name}: room, empty`);
  await page.getByRole("button", { name: "Type instead" }).click();
  await type(page, "We automatically fail over to a replica.");
  await page.getByTestId("typed-interrupt").click();
  await audit(page, `${name}: room, contradicted and cut off`);
  await type(page, "Wait. I meant manual failover.");
  await type(page, "We guarantee GDPR compliance and SOC 2 certification for all customer data.");
  await type(page, "Failed calls are retried automatically up to 3 times and fully traced.");
  await type(page, "maybe it could scale a bit");
  await type(page, "The cache is strongly consistent.");
  if (name === "phone") {
    for (const tab of ["Source", "Review", "Map"]) {
      await page.getByRole("tab", { name: tab }).click();
      await audit(page, `${name}: ${tab} tab, all bands filled`);
    }
    await page.getByRole("tab", { name: "Review" }).click();
  } else {
    await audit(page, `${name}: room, all five bands filled`);
  }
  await page.locator("details.rt-timeline summary").click();
  await audit(page, `${name}: timeline open`);
  await page.getByTestId("finish").click();
  await page.getByTestId("report").waitFor();
  await audit(page, `${name}: report`);
  await ctx.close();
}
await browser.close();
console.log(failed ? `\n${failed} state(s) with serious or critical violations` : "\nno serious or critical violations in any state");
process.exit(failed ? 1 : 0);
