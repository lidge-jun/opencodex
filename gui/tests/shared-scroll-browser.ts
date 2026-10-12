/** Isolated Chromium regression using production entry + lazy App CSS, in load order.
 * Build separately, then run `bun run test:shared-scroll [ignored-output-dir]`.
 * GUI_DIST selects a preserved build (absolute path); CHROME_BIN selects Chromium.
 * This mechanism fixture does not run React, account APIs, or a native WebView. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

const gui = resolve(import.meta.dir, "..");
const inputDist = process.env.GUI_DIST ?? join(gui, "dist");
if (!isAbsolute(inputDist)) throw new Error("GUI_DIST must be an absolute built GUI path.");
const dist = resolve(inputDist);
const output = resolve(process.argv[2] ?? join(gui, ".tmp/shared-scroll-browser"));
// Evidence must never become part of the shipped feature branch.
if (!output.split(sep).includes(".tmp")) throw new Error("Output must be inside an ignored .tmp directory.");
const chrome = process.env.CHROME_BIN || ["chromium", "chromium-browser", "google-chrome", "chrome"]
  .map(name => Bun.which(name)).find(Boolean);
if (!chrome) throw new Error("Set CHROME_BIN to an existing Chrome/Chromium executable.");
function assetPath(path: string) {
  const file = resolve(dist, path.replace(/^\/+/, ""));
  if (!file.startsWith(`${dist}${sep}`)) throw new Error(`Built asset escapes GUI_DIST: ${path}`);
  return file;
}
const index = await readFile(join(dist, "index.html"), "utf8");
const entryPath = index.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
const entryCss = [...index.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+\.css)"/g)].map(m => m[1]);
if (!entryPath || !entryCss.length) throw new Error("Missing built entry assets; ask the build owner to build GUI_DIST.");
const entry = await readFile(assetPath(entryPath), "utf8");
// Follow the dependency indices for App, rather than guessing App-*.css from a
// directory glob (which could silently select stale files or miss shared chunks).
const dependencies = entry.match(/m\.f\|\|\(m\.f=(\[[^\]]+\])/)?.[1];
const appIndices = entry.match(/import\([`"']\.\/App-[^`"']+\.js[`"']\),__vite__mapDeps\((\[[\d,\s]+\])/)?.[1];
if (!dependencies || !appIndices) throw new Error("Cannot resolve Vite lazy App CSS dependency order; update the harness for the new bundle format.");
const dependencyPaths = JSON.parse(dependencies) as string[];
const appDependencies = (JSON.parse(appIndices) as number[]).map(i => {
  if (!dependencyPaths[i]) throw new Error(`Missing App dependency index ${i}`);
  return dependencyPaths[i];
});
const lazyCss = appDependencies.filter(path => path.endsWith(".css"));
if (!lazyCss.length) throw new Error("Lazy App has no CSS dependencies; entry-only testing is insufficient.");
const cssPaths = [...new Set([...entryCss, ...lazyCss])];
const styles: string[] = [];
const assets: { path: string; sha256: string }[] = [];
for (const path of cssPaths) {
  const css = await readFile(assetPath(path), "utf8");
  if (/@import\s/i.test(css)) throw new Error(`Unresolved CSS import in ${path}; load it explicitly before testing.`);
  styles.push(css);
  assets.push({ path, sha256: new Bun.CryptoHasher("sha256").update(css).digest("hex") });
}

type Scenario = { page: "Codex" | "Claude" | "Combos"; long: boolean; desktop: boolean; collapsed: boolean; width: number; theme: string };
const height = 800;
function fixture(s: Scenario) {
  const brand = '<span class="name">opencodex</span>';
  const cards = Array.from({ length: s.long ? 12 : 1 }, (_, i) => `<section class="card" style="padding:24px;margin-bottom:16px"><h2>${s.page} account ${i + 1}</h2><p>Available quota and model selection</p><button type="button" class="btn">Account settings</button></section>`).join("");
  const final = '<button id="final-control" type="button" class="btn">Save selection</button>';
  const combos = `<div class="page-head"><h1>Combos</h1></div><div class="models-tab-panel--fill"><div class="combos-workspace-shell"><div class="combos-workspace-shell-body"><div class="combos-workspace-root"><aside class="combos-workspace-rail"><div class="combos-workspace-rail-list">${cards}${final}</div></aside><section>Selected combo</section></div></div></div></div>`;
  // The late static paragraph is deliberately OUTSIDE .main-inner. Its absolute
  // sr-only child must escape to the document, not a positioned/container-query
  // ancestor. A generic tall block alone does not reproduce the outer overflow.
  const ordinary = `<div class="main-inner"><div class="page-head"><h1>${s.page} accounts</h1></div>${cards}</div><p id="late-status">Account configuration <span class="sr-only">Settings refreshed</span></p>${final}`;
  return `<!doctype html><html lang="en" data-theme="${s.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles.join("\n").replaceAll("</style", "<\\/style")}</style></head><body><div id="root"><div class="app${s.desktop ? " app--desktop app--macos" : ""}${s.collapsed ? " app--nav-collapsed" : ""}"><header class="mobile-topbar"><button class="menu-toggle" aria-label="Menu">Menu</button><div class="brand">${brand}</div></header><div class="sidebar-top"><button class="sidebar-collapse" aria-label="Collapse">←</button></div><aside class="sidebar"><div class="drawer-head"><div class="brand">${brand}</div><button class="drawer-close" aria-label="Close">×</button></div><nav><button class="nav-item active">${s.page}</button><button class="nav-item">Models</button></nav><div class="sidebar-foot">Proxy connected</div></aside><main class="main">${s.desktop ? '<div class="main-top"><div class="quota-summary-bar">Quota available</div></div>' : '<div class="quota-summary-bar">Quota available</div>'}${s.page === "Combos" ? `<div class="main-inner main-inner--combos">${combos}</div>` : ordinary}</main></div></div></body></html>`;
}
const profile = await mkdtemp(join(tmpdir(), "ocx-shared-scroll-chrome-"));
const browser = Bun.spawn([chrome, "--headless", "--disable-gpu", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, ...(process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), "about:blank"], { stdout: "ignore", stderr: "pipe" });
let socket: WebSocket | undefined;
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const rows: { name: string; checks: Record<string, boolean>; measurements: unknown }[] = [];
await mkdir(output, { recursive: true });
try {
  let port = "";
  const deadline = Date.now() + 10_000;
  while (!port && Date.now() < deadline) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (browser.exitCode !== null) throw new Error(`Chrome exited ${browser.exitCode}: ${await new Response(browser.stderr).text()}`, { cause: error });
      await delay(50);
    }
  }
  if (!/^\d+$/.test(port)) throw new Error("Chrome did not expose its debugging port within 10 seconds.");
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Cannot create Chromium target: ${response.status}`);
  const target = await response.json() as { webSocketDebuggerUrl: string };
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const ws = socket;
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("CDP connection timed out")), 5_000);
    ws.addEventListener("open", () => { clearTimeout(timer); done(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); fail(new Error("CDP connection failed")); }, { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
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
      const timer = setTimeout(() => { pending.delete(next); fail(new Error(`CDP timeout: ${method}`)); }, 10_000);
      pending.set(next, { resolve: value => { clearTimeout(timer); done(value as T); }, reject: error => { clearTimeout(timer); fail(error); } });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  }
  async function evaluate<T>(expression: string): Promise<T> {
    const result = await cdp<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  }
  const paint = () => evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("Network.setBlockedURLs", { urls: ["*"] }); // no account APIs, fonts, or external assets
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const { frameTree } = await cdp<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  async function render(s: Scenario) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: s.width, height, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.setDocumentContent", { frameId: frameTree.frame.id, html: fixture(s) });
    await evaluate('window.scrollTo(0,0); document.body.scrollTop=0');
    await paint();
  }
  async function screenshot(name: string, width: number) {
    const scroll = await evaluate<number>('scrollY');
    const png = await cdp<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { x: 0, y: scroll, width, height, scale: 0.5 } });
    await writeFile(join(output, `${name}.png`), Buffer.from(png.data, "base64"));
  }
  const measure = () => evaluate<{
    app: { bottom: number }; rail: { top: number; bottom: number; width: number }; stripTop: number;
    bodyScroll: number; windowScroll: number; documentHeight: number; documentWidth: number; finalReachable: boolean;
    statusPosition: string; srPosition: string; srOffsetParent: string | null;
  }>(`(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {top:r.top,bottom:r.bottom,width:r.width}; };
    const final = document.querySelector('#final-control'), r = final.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    const sr = document.querySelector('.sr-only'), status = document.querySelector('#late-status');
    return {app:box('.app'),rail:box('.sidebar'),stripTop:box('.sidebar-top').top,
      bodyScroll:document.body.scrollTop,windowScroll:scrollY,documentHeight:document.documentElement.scrollHeight,
      documentWidth:document.documentElement.scrollWidth,
      finalReachable:r.top>=0 && r.bottom<=innerHeight+1 && !!hit && (hit===final || final.contains(hit)),
      statusPosition:status ? getComputedStyle(status).position : '',srPosition:sr ? getComputedStyle(sr).position : '',srOffsetParent:sr?.offsetParent?.className ?? null};
  })()`);
  function record(name: string, checks: Record<string, boolean>, measurements: unknown) {
    rows.push({ name, checks, measurements });
    const failed = Object.keys(checks).filter(key => !checks[key]);
    if (failed.length) console.error(`FAIL ${name}: ${failed.join(", ")}`);
  }
  const variants = [
    { page: "Codex", long: true, desktop: false, collapsed: false },
    { page: "Claude", long: true, desktop: true, collapsed: false },
    { page: "Claude", long: true, desktop: false, collapsed: true },
    { page: "Codex", long: false, desktop: true, collapsed: true },
    { page: "Claude", long: false, desktop: false, collapsed: false },
  ] as const;
  for (const theme of ["light", "dark"]) for (const width of [1280, 1024, 768, 390, 320]) for (const variant of variants) {
    const s = { ...variant, theme, width };
    await render(s);
    // Critical sequence: exhaust BODY first, then WINDOW. One scroll misses the
    // second scroller and can leave the rail looking correctly viewport-bound.
    await evaluate('document.body.scrollTop=document.body.scrollHeight');
    await paint();
    const afterBody = await measure();
    await evaluate('window.scrollTo(0,document.documentElement.scrollHeight)');
    await paint();
    const end = await measure();
    const expandedRail = width > 760 && !s.collapsed;
    record(`${theme}-${width}-${s.page}-${s.long ? "long" : "short"}-${s.desktop ? "desktop" : "web"}-${s.collapsed ? "collapsed" : "expanded"}`, {
      appCoversViewport: end.app.bottom >= height - 1,
      singleDocumentScroller: afterBody.bodyScroll === 0 && end.bodyScroll === 0,
      railViewportBound: !expandedRail || (Math.abs(end.rail.top) <= 1 && Math.abs(end.rail.bottom - height) <= 1),
      collapsedRailHidden: width <= 760 || !s.collapsed || end.rail.width === 0,
      titlebarBound: width <= 760 || Math.abs(end.stripTop) <= 1,
      finalControlReachable: end.finalReachable,
      horizontalGuard: end.documentWidth <= width,
      contentLength: s.long ? end.windowScroll > 0 || afterBody.bodyScroll > 0 : end.documentHeight <= height + 1,
      escapedStatusFixture: end.statusPosition === "static" && end.srPosition === "absolute" && end.srOffsetParent !== "main-inner",
    }, { afterBody, end });
    if (width === 1280 && theme === "dark" && s.long && !s.collapsed) await screenshot(`${s.page.toLowerCase()}-end`, width);
  }

  // Mirrors only App's existing body-overflow effect. Actual React dismissal,
  // Escape, navigation and resize handling are separately exercised by main QA.
  for (const width of [390, 320]) for (const desktop of [false, true]) {
    await render({ page: "Codex", long: true, desktop, collapsed: false, width, theme: "dark" });
    await evaluate('window.scrollTo(0,400)');
    await paint();
    const before = await evaluate<number>('scrollY');
    const previousOverflow = await evaluate<string>('document.body.style.overflow');
    await evaluate('document.body.style.overflow="hidden";document.querySelector(".sidebar").classList.add("open")');
    await paint();
    const opened = await evaluate<number>('scrollY');
    await cdp("Input.synthesizeScrollGesture", { x: width - 10, y: 500, yDistance: -400, speed: 1000, gestureSourceType: "mouse" });
    await paint();
    const locked = await evaluate<{ scroll: number; overflow: string; railTop: number; railBottom: number }>('({scroll:scrollY,overflow:getComputedStyle(document.documentElement).overflowY,railTop:document.querySelector(".sidebar").getBoundingClientRect().top,railBottom:document.querySelector(".sidebar").getBoundingClientRect().bottom})');
    await evaluate(`document.querySelector('.sidebar').classList.remove('open');document.body.style.overflow=${JSON.stringify(previousOverflow)}`);
    await paint();
    const restored = await evaluate<{ scroll: number; overflow: string; bodyInline: string }>('({scroll:scrollY,overflow:getComputedStyle(document.documentElement).overflowY,bodyInline:document.body.style.overflow})');
    await cdp("Input.synthesizeScrollGesture", { x: width - 10, y: 500, yDistance: -300, speed: 1000, gestureSourceType: "mouse" });
    await paint();
    const closedScroll = await evaluate<number>('scrollY');
    record(`drawer-${width}-${desktop ? "desktop" : "web"}`, {
      rootLocked: locked.overflow === "hidden", wheelLocked: Math.abs(locked.scroll - opened) <= 1,
      drawerBound: Math.abs(locked.railTop) <= 1 && Math.abs(locked.railBottom - height) <= 1,
      rootRestored: restored.overflow !== "hidden", bodyEffectRestored: restored.bodyInline === previousOverflow,
      positionRestored: Math.abs(restored.scroll - before) <= 1, wheelRestored: closedScroll > restored.scroll + 10,
    }, { before, opened, locked, restored, closedScroll });
  }
  for (const width of [1280, 768, 390, 320]) for (const desktop of [false, true]) {
    await render({ page: "Combos", long: true, desktop, collapsed: false, width, theme: "light" });
    await evaluate('document.querySelector(".combos-workspace-rail-list").scrollTop=1e6;document.body.scrollTop=1e6;window.scrollTo(0,1e6)');
    await paint();
    const end = await measure();
    const workspace = await evaluate<{ top: number; bottom: number; scrolled: number }>('(() => {const r=document.querySelector(".combos-workspace-shell").getBoundingClientRect();return {top:r.top,bottom:r.bottom,scrolled:document.querySelector(".combos-workspace-rail-list").scrollTop};})()');
    record(`combos-${width}-${desktop ? "desktop" : "web"}`, {
      // Mobile Combos can intentionally use natural document height. Assert its
      // bottom leaves no blank tail, without imposing desktop's viewport cap.
      workspaceContained: width > 760 ? workspace.top >= 0 && workspace.bottom <= height + 1 : workspace.bottom >= 0 && workspace.bottom <= height + 1,
      internalScrollerWorks: workspace.scrolled > 0, finalControlReachable: end.finalReachable,
      noOuterScroll: end.bodyScroll === 0 && (width <= 760 || end.windowScroll === 0),
      appCoversViewport: end.app.bottom >= height - 1,
    }, { end, workspace });
  }
  const failures = rows.filter(row => Object.values(row.checks).includes(false));
  await writeFile(join(output, "results.json"), JSON.stringify({ scope: "Offline synthetic shell geometry with production entry and lazy App CSS; drawer effect mirrored; no real React/account/native execution", dist, assets, browser: await cdp("Browser.getVersion"), total: rows.length, failed: failures.length, cases: rows }, null, 2));
  console.log(`${failures.length ? "FAIL" : "PASS"}: ${rows.length} shared-scroll cases, ${failures.length} failures; ${output}`);
  if (failures.length) process.exitCode = 1;
} catch (error) {
  const fatal = error instanceof Error ? error.stack ?? error.message : String(error);
  await writeFile(join(output, "error.json"), JSON.stringify({ dist, assets, fatal, cases: rows }, null, 2));
  throw error;
} finally {
  socket?.close();
  browser.kill();
  await Promise.race([browser.exited, delay(2_000)]);
  if (browser.exitCode === null) { browser.kill("SIGKILL"); await browser.exited; }
  await rm(profile, { recursive: true, force: true });
}
