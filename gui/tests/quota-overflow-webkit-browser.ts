/** Run against isolated Vite/proxy; quota responses below are entirely synthetic. */
import { pathToFileURL } from "node:url";
const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!modulePath?.startsWith("/")) throw new Error("PLAYWRIGHT_MODULE_PATH must be an absolute path");
const { webkit } = await import(pathToFileURL(modulePath).href);
const browser = await webkit.launch({ headless: true });
const base = process.env.GUI_TEST_BASE ?? "http://127.0.0.1:15174";
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  await page.route("**/api/provider-quotas", route => {
    const now = Date.now();
    const reports = Array.from({ length: 8 }, (_, i) => ({ provider: `synthetic-${i}`,
      label: i === 7 ? "A long synthetic provider label for quota details" : `Synthetic provider ${i}`,
      updatedAt: now, quota: { weeklyPercent: 25 + i, updatedAt: now } }));
    return route.fulfill({ json: { reports } });
  });
  await page.goto(`${base}/#models`, { waitUntil: "domcontentloaded" });
  const next = page.locator(".quota-summary-scroll--next");
  const prev = page.locator(".quota-summary-scroll--prev");
  await next.waitFor();
  const scroller = page.locator(".quota-summary-scroller");
  const start = await scroller.evaluate(el => ({ before: getComputedStyle(el, "::before").display,
    after: getComputedStyle(el, "::after").display, image: getComputedStyle(el, "::after").backgroundImage }));
  if (start.before !== "none" || start.after === "none" || start.image === "none") throw new Error(`Missing end-edge fade: ${JSON.stringify(start)}`);
  await page.locator(".quota-summary-chip").first().focus();
  if (await next.getAttribute("aria-disabled") === "true"
      || await scroller.evaluate(el => getComputedStyle(el, "::after").display) !== "none") {
    throw new Error("End-edge fade obscures keyboard focus while more providers remain");
  }
  await next.focus();
  for (let i = 0; i < 8; i++) {
    if (await next.getAttribute("aria-disabled") === "true") break;
    await next.evaluate((button: HTMLElement) => button.click());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  if (await next.getAttribute("aria-disabled") !== "true") throw new Error("Next control did not reach end");
  const end = await scroller.evaluate(el => ({ before: getComputedStyle(el, "::before").display,
    after: getComputedStyle(el, "::after").display }));
  if (end.before === "none" || end.after !== "none") throw new Error(`Missing start-edge fade: ${JSON.stringify(end)}`);
  const last = page.locator(".quota-summary-chip").last();
  await last.hover();
  const popover = page.locator(".quota-summary-popover");
  await popover.waitFor();
  if (!(await popover.innerText()).includes("A long synthetic provider label for quota details")) throw new Error("Full label missing from popover");
  const hit = await popover.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest(".quota-summary-popover") === el;
  });
  if (!hit) throw new Error("Quota popover is visually clipped or covered");
  await last.focus();
  if (await scroller.evaluate(el => getComputedStyle(el, "::before").display) !== "none") throw new Error("Keyboard focus ring is faded");
  for (let i = 0; i < 8; i++) {
    if (await prev.getAttribute("aria-disabled") === "true") break;
    await prev.evaluate((button: HTMLElement) => button.click());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  if (await prev.getAttribute("aria-disabled") !== "true") throw new Error("Previous control did not reach start");
  console.log("PASS: quota fade, paging, full-label popover, and keyboard focus");
} finally { await browser.close(); }
