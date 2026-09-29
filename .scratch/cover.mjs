import { chromium } from "@playwright/test";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto("file:///home/user/viva/docs/submission/cover.html");
await p.waitForTimeout(500);
await p.screenshot({ path: "docs/submission/cover.png" });
await b.close();
