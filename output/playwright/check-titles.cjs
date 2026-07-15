const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto("http://127.0.0.1:5173/#providers", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const opts = [...document.querySelectorAll('[role="option"]')];
    opts.find(o => (o.getAttribute("aria-label")||"").includes("cursor"))?.click();
  });
  await page.waitForTimeout(800);
  const titles = await page.evaluate(() => [...document.querySelectorAll(".providers-workspace-section-title")].map(t => t.textContent));
  console.log("section titles", titles);
  // hard reload once
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const opts = [...document.querySelectorAll('[role="option"]')];
    opts.find(o => (o.getAttribute("aria-label")||"").includes("cursor"))?.click();
  });
  await page.waitForTimeout(800);
  const titles2 = await page.evaluate(() => [...document.querySelectorAll(".providers-workspace-section-title")].map(t => t.textContent));
  console.log("after reload", titles2);
  await page.screenshot({ path: "cursor-detail2.png" });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
