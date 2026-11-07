/** Run against isolated Vite/proxy; no reload action is invoked. */
import { pathToFileURL } from "node:url";
const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!modulePath?.startsWith("/")) throw new Error("PLAYWRIGHT_MODULE_PATH must be an absolute path");
const { webkit } = await import(pathToFileURL(modulePath).href);
const browser = await webkit.launch({ headless: true });
const base = process.env.GUI_TEST_BASE ?? "http://127.0.0.1:15174";
let failures = 0;
try {
  for (const state of ["stale", "fresh", "not_running", "unknown", "error"]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: "dark" });
    await page.route("**/api/system/codex-app-server", route => route.fulfill(
      state === "error" ? { status: 500, body: "error" }
        : { status: 200, json: { state, runningCount: state === "not_running" ? 0 : 1 } },
    ));
    const response = page.waitForResponse("**/api/system/codex-app-server");
    await page.goto(`${base}/#models`, { waitUntil: "domcontentloaded" });
    await response;
    await page.locator(".models-workspace-rail-row").first().waitFor();
    if (state === "stale") await page.locator(".codex-stale-banner").waitFor();
    else await page.waitForFunction(() => !document.querySelector(".codex-stale-banner"));
    const head = await page.locator(".page-head-actions").getByRole("button", { name: "Reload Codex models" }).count();
    const banner = await page.locator(".codex-stale-banner").getByRole("button", { name: "Reload Codex models" }).count();
    if (head !== (state === "stale" ? 0 : 1) || banner !== (state === "stale" ? 1 : 0)) {
      failures++;
      console.error(`FAIL ${state}: head=${head} banner=${banner}`);
    }
    await page.close();
  }
  console.log(`${failures ? "FAIL" : "PASS"}: one reload action for each app-server state, ${failures} failures`);
} finally { await browser.close(); }
if (failures) process.exitCode = 1;
