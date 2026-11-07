/** Checks v2 status labels and provider alias identifiers with synthetic API data. */
import { pathToFileURL } from "node:url";
const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!modulePath?.startsWith("/")) throw new Error("PLAYWRIGHT_MODULE_PATH must be an absolute path");
const { webkit } = await import(pathToFileURL(modulePath).href);
const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.route("**/api/aliases", route => route.fulfill({ json: {
    providers: { anthropic: "synthetic-alias" }, models: {}, defaults: { global: false, providers: {} },
  } }));
  await page.goto(`${process.env.GUI_TEST_BASE ?? "http://127.0.0.1:15174"}/#models`, { waitUntil: "domcontentloaded" });
  const status = page.locator(".models-chip").filter({ hasText: "OpenAI native" }).first();
  const identifier = page.locator(".models-chip--identifier").filter({ hasText: "synthetic-alias" }).first();
  await status.waitFor();
  await identifier.waitFor();
  const measure = (element: HTMLElement, tokenName: string) => {
    const reference = document.createElement("span");
    reference.style.fontFamily = `var(${tokenName})`;
    element.append(reference);
    const actual = getComputedStyle(element).fontFamily, expected = getComputedStyle(reference).fontFamily;
    reference.remove();
    return { actual, expected };
  };
  const fonts = { status: await status.evaluate(measure, "--font-ui"),
    identifier: await identifier.evaluate(measure, "--font-code") };
  if (fonts.status.actual !== fonts.status.expected || fonts.identifier.actual !== fonts.identifier.expected
      || fonts.status.actual === fonts.identifier.actual) throw new Error(`Wrong chip fonts: ${JSON.stringify(fonts)}`);
  console.log(`PASS: status uses UI sans and alias remains monospace: ${JSON.stringify(fonts)}`);
} finally { await browser.close(); }
