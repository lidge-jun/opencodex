/** Run against an isolated Vite/proxy seeded with at least 12 synthetic providers.
 * PLAYWRIGHT_MODULE_PATH and PLAYWRIGHT_BROWSERS_PATH point to temporary tooling. */
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!modulePath?.startsWith("/")) throw new Error("PLAYWRIGHT_MODULE_PATH must be an absolute path");
const { webkit } = await import(pathToFileURL(modulePath).href);
const base = process.env.GUI_TEST_BASE ?? "http://127.0.0.1:15174";
const screenshots = process.env.RAIL_SCREENSHOT_DIR;
if (screenshots && !screenshots.startsWith("/")) throw new Error("RAIL_SCREENSHOT_DIR must be absolute");
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await webkit.launch({ headless: true });
let failures = 0;
try {
  const context = await browser.newContext({ viewport: { width: 860, height: 1000 }, colorScheme: "dark" });
  await context.addInitScript(() => localStorage.setItem("ocx-theme", "dark"));
  const page = await context.newPage();
  // Playwright's WebKit protocol controls page zoom (the desktop shell uses WKWebView's
  // pageZoom). This private protocol is intentionally required: no CSS-zoom fallback.
  const pageProxy = page._connection.toImpl(page).delegate._pageProxySession;
  if (!pageProxy?.connection?.browserSession || !pageProxy.sessionId) throw new Error("WebKit page-zoom protocol unavailable");
  await page.goto(`${base}/#models`, { waitUntil: "domcontentloaded" });
  await page.locator(".models-workspace-rail-row").first().waitFor();
  for (const width of [1440, 1100, 860, 768]) for (const zoom of [1, 0.9]) {
    await page.setViewportSize({ width, height: 1000 });
    await pageProxy.connection.browserSession.send("Playwright.setPageZoomFactor", { pageProxyId: pageProxy.sessionId, zoomFactor: zoom });
    const ratio = await page.evaluate(() => window.devicePixelRatio);
    if (Math.abs(ratio - zoom) > 0.02) throw new Error(`Page zoom did not take effect: ${zoom}, DPR ${ratio}`);
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector(".models-workspace-rail-list")!.scrollTop = 0; });
    const rows = page.locator(".models-workspace-rail-row");
    const count = await rows.count();
    if (count < 12) throw new Error(`Expected at least 12 synthetic rows; got ${count}`);
    for (let i = 0; i < count; i++) {
      const result = await rows.nth(i).evaluate((row: HTMLElement) => {
        const bounds = row.getBoundingClientRect();
        const labels = row.querySelectorAll(".models-workspace-rail-name, .models-workspace-rail-meta");
        if (!row.querySelector(".models-workspace-rail-name") || !row.querySelector(".models-workspace-rail-meta") || labels.length !== 2) {
          throw new Error("Expected one provider name and one count in every rail row");
        }
        return Array.from(labels)
          .map(element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const text = range.getBoundingClientRect();
            return { label: element.textContent, rowTop: bounds.top, rowBottom: bounds.bottom,
              rowHeight: bounds.height, textTop: text.top, textBottom: text.bottom };
          });
      });
      for (const item of result) if (item.textTop < item.rowTop - 0.5 || item.textBottom > item.rowBottom + 0.5) {
        failures++;
        console.error(`FAIL ${width}/${zoom}/row-${i}: ${JSON.stringify(item)}`);
      }
    }
    if (screenshots) await page.screenshot({ path: join(screenshots, `rail-${width}-${zoom}.png`) });
    {
      // A short viewport forces the desktop rail to overflow too.
      await page.setViewportSize({ width, height: 600 });
      const list = page.locator(".models-workspace-rail-list");
      const scrollable = await list.evaluate(element => element.scrollHeight > element.clientHeight);
      if (!scrollable) { failures++; console.error(`FAIL ${width}/${zoom}: rail does not scroll`); }
      await rows.last().scrollIntoViewIfNeeded();
      const lastVisible = await rows.last().evaluate(element => {
        const row = element.getBoundingClientRect(), list = element.parentElement!.getBoundingClientRect();
        // WebKit can round scroll positions by up to one device pixel at fractional page zoom.
        const tolerance = 1 / window.devicePixelRatio;
        return row.top >= list.top - tolerance && row.bottom <= list.bottom + tolerance;
      });
      if (!lastVisible) { failures++; console.error(`FAIL ${width}/${zoom}: last row inaccessible`); }
    }
  }
  console.log(`${failures ? "FAIL" : "PASS"}: provider rail geometry, ${failures} failures`);
} finally {
  await browser.close();
}
if (failures) process.exitCode = 1;
