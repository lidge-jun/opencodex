const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto("http://127.0.0.1:5173/#providers", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  // click openrouter or cursor if present
  const names = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].map(b => b.getAttribute("aria-label")));
  console.log("providers", names?.slice(0, 8));
  // click cursor
  await page.evaluate(() => {
    const opts = [...document.querySelectorAll('[role="option"]')];
    const c = opts.find(o => (o.getAttribute("aria-label")||"").includes("cursor"))
      || opts.find(o => (o.getAttribute("aria-label")||"").includes("openrouter"))
      || opts[0];
    c?.click();
  });
  await page.waitForTimeout(800);
  const text = await page.evaluate(() => document.querySelector(".providers-workspace-detail")?.innerText?.slice(0, 1500));
  console.log("---detail---\n", text);
  await page.screenshot({ path: "detail-auth-check.png" });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
