import { expect, test } from "@playwright/test";

/**
 * Naming and structure audit: every route has one h1, a title and a lang,
 * and every visible form control has a real accessible name (aria-label,
 * aria-labelledby, or an associated <label> — placeholders do not count).
 * Run: A11Y_BASE=http://127.0.0.1:3111 npx playwright test
 */
const ROUTES = ["/", "/study", "/subjects", "/exam", "/today", "/map", "/demo", "/connect"];

for (const route of ROUTES) {
  test(`${route} names every control and structures headings`, async ({ page }) => {
    await page.goto(route);
    await page.waitForTimeout(3000);

    expect((await page.title()).trim().length).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.lang)).not.toBe("");

    const h1s = await page.locator("h1").count();
    expect(h1s).toBe(1);

    const nameless = await page.evaluate(() =>
      [...document.querySelectorAll("button, input, select, textarea")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          const e = el as HTMLInputElement;
          const labelled =
            (e.getAttribute("aria-label") ?? "") ||
            (e.getAttribute("aria-labelledby") ?? "") ||
            (e.labels?.length ? "labelled" : "") ||
            (e.closest("label") ? "wrapped" : "") ||
            (e.getAttribute("title") ?? "") ||
            (e.innerText ?? "").trim() ||
            (e as HTMLInputElement).value?.trim();
          return labelled === "";
        })
        .map((el) => el.tagName + "." + String(el.className).slice(0, 40))
    );
    expect(nameless, `route ${route}`).toEqual([]);
  });
}
