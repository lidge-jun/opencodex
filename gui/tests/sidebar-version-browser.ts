/** Built-CSS geometry regression. Run after `bun run build` with CHROME_BIN set
 * when Chrome/Chromium is not on PATH. No browser package or downloads required.
 * The fixture uses the real bundled stylesheet and the App drawer/topbar markup;
 * it intentionally does not connect to a user's proxy or credentials. */
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const gui = resolve(import.meta.dir, "..");
const dist = join(gui, "dist");
const output = resolve(process.argv[2] ?? join(gui, ".tmp/sidebar-version-browser"));
const chrome = process.env.CHROME_BIN || ["chromium", "chromium-browser", "google-chrome", "chrome"]
  .map(name => Bun.which(name)).find(Boolean);
if (!chrome) throw new Error("Set CHROME_BIN to Chrome/Chromium, then run bun run test:sidebar-version.");
const index = await readFile(join(dist, "index.html"), "utf8");
const cssPath = index.match(/<link\b[^>]*href="([^"]+\.css)"/)?.[1];
if (!cssPath) throw new Error("Build the GUI first: bun run build.");
const cssFile = resolve(dist, cssPath.replace(/^\/+/, ""));
if (!cssFile.startsWith(`${dist}${sep}`)) throw new Error("Built CSS must stay inside gui/dist.");
const css = await readFile(cssFile, "utf8");
const logo = `data:image/png;base64,${(await readFile(join(dist, "logo.png"))).toString("base64")}`;
const brand = `<button type="button" class="brand brand-home" aria-label="Home"><span class="brand-logo"></span><span class="name">opencodex</span><span class="ver">v2.56.0</span></button>`;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>.brand-logo { mask-image:url("${logo}"); -webkit-mask-image:url("${logo}"); }</style></head><body><div class="app"><header class="mobile-topbar"><button class="menu-toggle" aria-label="Menu">☰</button>${brand}<div class="mobile-topbar-actions"><button class="sidebar-orb" aria-label="Stop">⏻</button><button class="sidebar-orb" aria-label="Restart">↻</button></div></header><aside class="sidebar open"><div class="drawer-head">${brand}<button class="menu-toggle drawer-close" aria-label="Close">×</button></div></aside><main class="main"></main></div></body></html>`;
const profile = await mkdtemp(join(tmpdir(), "ocx-sidebar-chrome-"));
const browser = Bun.spawn([chrome, "--headless", "--disable-gpu", "--disable-background-networking",
  "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  ...(process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), "about:blank"],
{ stdout: "ignore", stderr: "ignore" });
let socket: WebSocket | undefined;
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
try {
  let debugPort = "";
  const deadline = Date.now() + 10_000;
  while (!debugPort && Date.now() < deadline) {
    try { debugPort = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch { await delay(50); }
  }
  if (!/^\d+$/.test(debugPort)) throw new Error("Chrome did not expose its local debugging port within 10 seconds.");
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Cannot create browser target: ${response.status}`);
  const target = await response.json() as { webSocketDebuggerUrl: string };
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const ws = socket;
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("CDP connection timed out")), 5_000);
    ws.addEventListener("open", () => { clearTimeout(timer); done(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); fail(new Error("CDP connection failed")); }, { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  ws.addEventListener("message", event => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
  });
  function cdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((done, fail) => {
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); fail(new Error(`CDP timeout: ${method}`)); }, 5_000);
      pending.set(next, { resolve: value => { clearTimeout(timer); done(value as T); }, reject: error => { clearTimeout(timer); fail(error); } });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  }
  async function evaluate<T>(expression: string): Promise<T> {
    const result = await cdp<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  }
  await cdp("Page.enable");
  // Offline document: no proxy, management API, external assets or browser navigation.
  const { frameTree } = await cdp<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  await cdp("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate<boolean>('document.readyState === "complete" && !!document.querySelector(".drawer-head .ver")')) break;
    if (attempt === 99) throw new Error(`Built-CSS fixture did not finish loading: ${await evaluate<string>('JSON.stringify({url:location.href,state:document.readyState,html:document.body?.innerHTML.slice(0,500)})')}`);
    await delay(25);
  }
  const cases: unknown[] = [];
  const versions = ["2.56.0", "2.57.0", "2.56.0-beta.1", `2.56.0-preview.20260916+${"a".repeat(64)}`];
  await mkdir(output, { recursive: true });
  for (const theme of ["light", "dark"]) for (const width of [320, 360, 375, 414, 760, 761, 1024, 1920]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    for (const version of versions) for (const wideFont of [false, true]) {
      await evaluate(`(() => {
        document.documentElement.dataset.theme = ${JSON.stringify(theme)};
        document.documentElement.style.setProperty("--text-subtitle", ${JSON.stringify(wideFont ? "18px" : "16px")});
        document.querySelectorAll(".ver").forEach(el => { el.textContent = ${JSON.stringify(`v${version}`)}; });
      })()`);
      const geometry = await evaluate<{ ok: boolean; [key: string]: unknown }>(`(() => {
        const box = el => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
        const brand = document.querySelector(".drawer-head .brand");
        const badge = brand.querySelector(".ver");
        const close = document.querySelector(".drawer-close");
        const b=box(badge), h=box(brand), c=box(close), n=box(brand.querySelector(".name"));
        const range = document.createRange(); range.selectNodeContents(badge);
        const text = [...range.getClientRects()].map(r => ({left:r.left,right:r.right,top:r.top,bottom:r.bottom}));
        const visible = b.width > 0 && b.height > 0 && text.length > 0;
        const bounded = b.left >= h.left - .5 && b.right <= h.right + .5;
        const complete = badge.scrollWidth <= badge.clientWidth + 1 && text.every(r => r.left >= b.left - .5 && r.right <= b.right + .5 && r.top >= b.top - .5 && r.bottom <= b.bottom + .5);
        const overlapsClose = c.width > 0 && b.left < c.right && b.right > c.left && b.top < c.bottom && b.bottom > c.top;
        const style = getComputedStyle(badge);
        const shortRelease = /^v\\d+\\.\\d+\\.\\d+$/.test(badge.textContent);
        const headerStyle = getComputedStyle(brand);
        const logo = box(brand.querySelector(".brand-logo"));
        const contentWidth = h.width - parseFloat(headerStyle.paddingLeft) - parseFloat(headerStyle.paddingRight);
        const requiredWidth = logo.width + n.width + b.width + 2 * parseFloat(headerStyle.columnGap);
        // Font fallbacks differ by OS. Wrapping the whole badge when the row is
        // genuinely full is intended; clipping its text or splitting a short
        // version is not. Require the same row only when all three items fit.
        const singleLine = !shortRelease || text.length === 1;
        const rowFits = requiredWidth <= contentWidth + .5;
        const sameRowWhenPossible = !shortRelease || !rowFits || (b.top < n.bottom && b.bottom > n.top);
        return { ok: visible && bounded && complete && !overlapsClose && singleLine && sameRowWhenPossible, badge:b, brand:h, name:n, close:c, text, overlapsClose, bounded, complete, singleLine, sameRowWhenPossible, rowFits, requiredWidth, contentWidth, font:headerStyle.fontFamily, overflow:style.textOverflow, value:badge.textContent };
      })()`);
      const row = { theme, width, version, wideFont, ...geometry };
      cases.push(row);
      if (!geometry.ok) {
        await writeFile(join(output, "failure.json"), JSON.stringify(row, null, 2));
        throw new Error(`Sidebar geometry regression: ${JSON.stringify(row)}`);
      }
      if (theme === "dark" && width === 1024 && version === "2.56.0" && wideFont) {
        const image = await cdp<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x:0, y:0, width:232, height:110, scale:1 } });
        await writeFile(join(output, "sidebar-built-css.png"), Buffer.from(image.data, "base64"));
      }
    }
  }
  const version = await cdp("Browser.getVersion");
  await writeFile(join(output, "results.json"), JSON.stringify({ scope: "Real Chromium geometry with built production CSS; isolated App header markup, no live proxy", browser: version, cssPath, cssSha256: new Bun.CryptoHasher("sha256").update(css).digest("hex"), cases }, null, 2));
  console.log(`PASS: ${cases.length} built-CSS browser cases; full version visible, badge bounded, no drawer-close overlap.`);
} finally {
  socket?.close();
  browser.kill();
  await Promise.race([browser.exited, delay(2_000)]);
  if (browser.exitCode === null) { browser.kill("SIGKILL"); await browser.exited; }
  await rm(profile, { recursive: true, force: true });
}
