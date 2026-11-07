/** Run against an isolated Vite/proxy seeded with at least 12 synthetic providers.
 * PLAYWRIGHT_MODULE_PATH and PLAYWRIGHT_BROWSERS_PATH point to temporary tooling. */
import { pathToFileURL } from "node:url";

const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!modulePath?.startsWith("/")) throw new Error("PLAYWRIGHT_MODULE_PATH must be an absolute path");
const { webkit } = await import(pathToFileURL(modulePath).href);
const base = process.env.GUI_TEST_BASE ?? "http://127.0.0.1:15174";
const browser = await webkit.launch({ headless: true });
let failures = 0;
try {
  const context = await browser.newContext({ viewport: { width: 860, height: 1000 }, colorScheme: "dark" });
  await context.addInitScript(() => localStorage.setItem("ocx-theme", "dark"));
  const page = await context.newPage();
  await page.goto(`${base}/#models`, { waitUntil: "domcontentloaded" });
  await page.locator(".models-workspace-rail-row").first().waitFor();
  for (const width of [1440, 1100, 860, 768]) for (const zoom of [1, 0.9]) {
    await page.setViewportSize({ width, height: 1000 });
    // CSS zoom approximates the desktop setting; this does not certify native app zoom.
    await page.evaluate(value => { document.body.style.zoom = String(value); }, zoom);
    const rows = page.locator(".models-workspace-rail-row");
    const count = await rows.count();
    if (count < 12) throw new Error(`Expected at least 12 synthetic rows; got ${count}`);
    for (let i = 0; i < count; i++) {
      const result = await rows.nth(i).evaluate((row: HTMLElement) => {
        const bounds = row.getBoundingClientRect();
        return Array.from(row.querySelectorAll(".models-workspace-rail-name, .models-workspace-rail-meta"))
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
    if (width <= 860) {
      const list = page.locator(".models-workspace-rail-list");
      const scrollable = await list.evaluate(element => element.scrollHeight > element.clientHeight);
      if (!scrollable) { failures++; console.error(`FAIL ${width}/${zoom}: rail does not scroll`); }
      await rows.last().scrollIntoViewIfNeeded();
      const lastVisible = await rows.last().evaluate(element => {
        const row = element.getBoundingClientRect(), list = element.parentElement!.getBoundingClientRect();
        return row.top >= list.top - 0.5 && row.bottom <= list.bottom + 0.5;
      });
      if (!lastVisible) { failures++; console.error(`FAIL ${width}/${zoom}: last row inaccessible`); }
    }
  }
  console.log(`${failures ? "FAIL" : "PASS"}: provider rail geometry, ${failures} failures`);
} finally {
  await browser.close();
}
if (failures) process.exitCode = 1;
