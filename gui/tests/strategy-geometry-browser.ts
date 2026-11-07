/** Real WebKit geometry and hit testing. Start Vite first, then run with
 * PLAYWRIGHT_MODULE_PATH and PLAYWRIGHT_BROWSERS_PATH pointing to isolated tooling. */
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!modulePath?.startsWith("/")) throw new Error("PLAYWRIGHT_MODULE_PATH must be an absolute path to playwright/index.mjs");
const { webkit } = await import(pathToFileURL(modulePath).href);
const base = process.env.GUI_TEST_BASE ?? "http://127.0.0.1:15174";
const screenshots = process.env.STRATEGY_SCREENSHOT_DIR;
if (screenshots && !screenshots.startsWith("/")) throw new Error("STRATEGY_SCREENSHOT_DIR must be absolute");
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await webkit.launch({ headless: true });
const maxima = new Map<number, { locale: string; text: string; width: number }>();
let failures = 0;
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await page.goto(`${base}/tests/strategy-geometry.html`);
  await page.waitForFunction(() => !!document.documentElement.dataset.locales);
  const locales: string[] = JSON.parse((await page.locator('html').getAttribute('data-locales'))!);
  for (const width of [720, 1024]) for (const locale of locales) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/tests/strategy-geometry.html?locale=${locale}`);
    await page.locator('.cwi-strategy-seg button').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const buttons = page.locator('.cwi-strategy-seg button');
    if (await buttons.count() !== 6) throw new Error(`Expected six strategies at ${width}/${locale}`);
    for (let i = 0; i < 6; i++) {
      const button = buttons.nth(i);
      const result = await button.evaluate((element: HTMLElement) => {
        const bounds = element.getBoundingClientRect(), range = document.createRange();
        const segment = element.closest('.cwi-strategy-seg')!.getBoundingClientRect();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const fragments = Array.from(range.getClientRects())
          .filter(rect => rect.width > 0 && rect.height > 0)
          .map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
        return { label: element.textContent ?? "", left: bounds.left, right: bounds.right,
          top: bounds.top, bottom: bounds.bottom, segmentLeft: segment.left, segmentRight: segment.right, textWidth: text.width, fragments };
      });
      if (!maxima.has(i) || maxima.get(i)!.width < result.textWidth) maxima.set(i, { locale, text: result.label, width: result.textWidth });
      if (!result.fragments.length) {
        failures++;
        console.error(`FAIL ${width}/${locale}/${i}: no measurable text fragments`);
      }
      if (result.left < result.segmentLeft - 0.5 || result.right > result.segmentRight + 0.5) {
        failures++;
        console.error(`FAIL ${width}/${locale}/${i}: button exceeds segment bounds`);
      }
      for (const fragment of result.fragments) {
        const contained = fragment.left >= result.left - 0.5 && fragment.right <= result.right + 0.5
          && fragment.top >= result.top - 0.5 && fragment.bottom <= result.bottom + 0.5;
        await buttons.nth((i + 1) % 6).click();
        const x = fragment.right - Math.min(1, (fragment.right - fragment.left) / 2);
        const y = (fragment.top + fragment.bottom) / 2;
        const hit = await button.evaluate((element: HTMLElement, point: { x: number; y: number }) =>
          document.elementFromPoint(point.x, point.y)?.closest('button') === element, { x, y });
        await page.mouse.click(x, y);
        const clicked = hit && await button.getAttribute('aria-checked') === 'true';
        if (!contained || !clicked) {
          failures++;
          console.error(`FAIL ${width}/${locale}/${i}: ${JSON.stringify({ ...result, fragment, contained, clicked })}`);
        }
      }
    }
    const rowTops = await buttons.evaluateAll((elements: HTMLElement[]) => elements.map(element => Math.round(element.getBoundingClientRect().top)));
    if (width === 720 && new Set(rowTops).size < 2) {
      failures++;
      console.error(`FAIL ${width}/${locale}: strategy buttons do not wrap`);
    }
    const header = await page.locator('.combos-workspace-rail-header').evaluate((element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      const heading = element.querySelector('.combos-workspace-rail-heading')!.getBoundingClientRect();
      const button = element.querySelector('button')!;
      const b = button.getBoundingClientRect();
      return { contained: b.left >= bounds.left - 0.5 && b.right <= bounds.right + 0.5,
        overlap: heading.left < b.right && heading.right > b.left && heading.top < b.bottom && heading.bottom > b.top,
        textFits: button.scrollWidth <= button.clientWidth + 1 };
    });
    if (!header.contained || header.overlap || !header.textFits) {
      failures++;
      console.error(`FAIL ${width}/${locale}: rail header ${JSON.stringify(header)}`);
    }
    if (screenshots && ((width === 720 && locale === "fr") || (width === 1024 && locale === "vi"))) {
      await page.screenshot({ path: join(screenshots, `strategy-${width}-${locale}.png`) });
    }
  }
  for (const [index, value] of maxima) console.log(`longest ${index}: ${JSON.stringify(value)}`);
  console.log(`${failures ? 'FAIL' : 'PASS'}: ${locales.length * 2 * 6} localized strategy checks, ${failures} failures`);
} finally {
  await browser.close();
}
if (failures) process.exitCode = 1;
