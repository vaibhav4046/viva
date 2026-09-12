import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Automated accessibility audit: 0 serious+ violations on every route.
 * Run: npm run dev -- -p 3110  →  npm run test:accessibility
 */
const ROUTES = ["/", "/demo", "/exam", "/learn", "/today", "/memory"];

for (const route of ROUTES) {
  test(`${route} has no serious accessibility violations`, async ({ page }) => {
    await page.goto(route);
    // Let client hydration + demo boot settle.
    await page.waitForTimeout(route === "/demo" ? 4000 : 2500);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    const serious = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? "")
    );
    expect(
      serious.map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help}`),
      `route ${route}`
    ).toEqual([]);
  });
}

test("keyboard reaches the voice fallback and demo controls", async ({ page }) => {
  await page.goto("/demo");
  await page.waitForTimeout(3000);
  // Tab order must reach the typed input and Send without a mouse.
  await page.keyboard.press("Tab");
  let focused = false;
  for (let i = 0; i < 40; i++) {
    const id = await page.evaluate(() => document.activeElement?.id);
    if (id === "viva-type") {
      focused = true;
      break;
    }
    await page.keyboard.press("Tab");
  }
  expect(focused).toBe(true);
});

test("Thought Marks are announced via a polite live region (§80 J5)", async ({ page }) => {
  await page.goto("/demo");
  await page.waitForTimeout(3500);
  // The log region must exist with the right semantics before any thought.
  const region = page.locator('[role="log"][aria-live="polite"]');
  await expect(region).toHaveCount(1);
  // Type a thought and send: the region must receive announced content.
  await page.fill("#viva-type", "I don't understand positional encoding.");
  await page.click("text=Send");
  await expect(region).toContainText(/Positional|CONFUSION/i, { timeout: 20_000 });
});
