const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const logs = [];
  page.on("pageerror", e => logs.push("ERR " + e.message));
  page.on("console", m => { if (m.type()==="error") logs.push("CON " + m.text()); });
  await page.goto("http://127.0.0.1:5173/#providers", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const opts = [...document.querySelectorAll('[role="option"]')];
    opts.find(o => (o.getAttribute("aria-label")||"").includes("cursor"))?.click();
  });
  await page.waitForTimeout(1000);
  const hasAuth = await page.evaluate(() => !!document.querySelector(".pwi-auth-body, .pwi-auth-status-row"));
  console.log("hasAuthUI", hasAuth);
  console.log("logs", logs.slice(0, 10));
  // check if AuthAccountsCard code is in bundle - search source for pwi-auth-body
  const src = await page.content();
  console.log("html has pwi-auth", src.includes("pwi-auth"));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
