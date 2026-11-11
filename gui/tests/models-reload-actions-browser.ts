/** WebKit against an isolated GUI; both the restart and status responses are synthetic. */
import { pathToFileURL } from "node:url";
const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!modulePath?.startsWith("/")) throw new Error("PLAYWRIGHT_MODULE_PATH must be an absolute path");
const { webkit } = await import(pathToFileURL(modulePath).href);
const browser = await webkit.launch({ headless: true });
const base = process.env.GUI_TEST_BASE ?? "http://127.0.0.1:15174";
try {
  for (const state of ["stale", "fresh", "not_running", "unknown", "error"]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: "dark" });
    let reads = 0;
    const heldReads: Array<() => Promise<void>> = [];
    let signalHeld!: () => void;
    let held = new Promise<void>(resolve => { signalHeld = resolve; });
    await page.route("**/api/system/codex-app-server", route => {
      const next = reads++ === 0 ? "stale" : state;
      const fulfill = () => route.fulfill(next === "error" ? { status: 500, body: "error" }
        : { status: 200, json: { state: next, runningCount: next === "not_running" ? 0 : 1 } });
      if (reads === 1) return fulfill();
      return new Promise<void>(resolve => {
        heldReads.push(async () => { await fulfill(); resolve(); });
        signalHeld();
      });
    });
    await page.route("**/api/system/codex-restart", route => route.fulfill({ json: {
      success: true, stateBefore: "stale", synced: false, code: "nothing_running",
      requested: [], stopped: [], surviving: [], failed: [],
    } }));
    await page.goto(`${base}/tests/models-reload-focus.html`, { waitUntil: "domcontentloaded" });
    const head = page.locator(".page-head-actions").getByRole("button", { name: "Reload Codex models" });
    const banner = page.locator(".codex-stale-banner");
    await banner.waitFor();
    await banner.getByRole("button", { name: "Reload Codex models" }).click();
    const dialog = page.locator("dialog.modal-overlay");
    await dialog.waitFor();
    const secondRead = page.waitForRequest("**/api/system/codex-app-server");
    await dialog.getByRole("button", { name: "Reload Codex models" }).click();
    await secondRead;
    await held;
    // Let React commit any optimistic update while the response is still blocked.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (!await banner.isVisible() || await banner.getByRole("button", { name: "Reload Codex models" }).count() !== 1
      || await head.count() !== 0 || await page.locator("#root").getByRole("button", { name: "Reload Codex models" }).count() !== 1) {
      throw new Error(`${state}: stale banner and its single reload action must remain while the reread is pending`);
    }
    await heldReads[0]!();
    if (state === "stale") {
      // A reset removes the old banner, so the next held stale response must
      // visibly create it again instead of merely leaving the original mounted.
      held = new Promise<void>(resolve => { signalHeld = resolve; });
      const resetRead = page.waitForRequest("**/api/system/codex-app-server");
      await page.evaluate(() => window.dispatchEvent(new Event("fixture-refresh")));
      await resetRead;
      await held;
      await banner.waitFor({ state: "detached" });
      await heldReads[1]!();
      await banner.waitFor();
    } else {
      await banner.waitFor({ state: "detached" });
      await head.waitFor();
    }
    const headCount = await head.count();
    const bannerCount = await banner.getByRole("button", { name: "Reload Codex models" }).count();
    const total = await page.locator("#root").getByRole("button", { name: "Reload Codex models" }).count();
    if (headCount !== (state === "stale" ? 0 : 1) || bannerCount !== (state === "stale" ? 1 : 0) || total !== 1) {
      throw new Error(`${state}: head=${headCount} banner=${bannerCount} total=${total}`);
    }
    console.log(`PASS ${state}: one reload action after controlled status transition`);
    await page.close();
  }
} finally { await browser.close(); }
