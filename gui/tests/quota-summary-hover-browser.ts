/** Real-pointer regression for the quota popover gap. Run after `bun run build`.
 * Uses the actual React component and production CSS in isolated Chromium; no live API. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const gui = resolve(import.meta.dir, "..");
const output = resolve(process.argv[2] ?? join(gui, ".tmp/quota-summary-hover-browser"));
const chrome = process.env.CHROME_BIN || ["chromium", "chromium-browser", "google-chrome", "chrome"]
  .map(name => Bun.which(name)).find(Boolean);
if (!chrome) throw new Error("Set CHROME_BIN to Chrome/Chromium, then run bun run test:quota-hover.");
const assets = join(gui, "dist/assets");
const styles = await Promise.all((await readdir(assets)).filter(name => name.endsWith(".css"))
  .map(name => readFile(join(assets, name), "utf8")));
await mkdir(join(gui, ".tmp"), { recursive: true });
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(join(gui, ".tmp/quota-hover-fixture-"));
const profile = await mkdtemp(join(gui, ".tmp/quota-hover-chrome-"));
let browser: ReturnType<typeof Bun.spawn> | undefined;
let socket: WebSocket | undefined;
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
try {
  const entry = join(fixture, "entry.tsx");
  await writeFile(entry, `
    import { createRoot } from "react-dom/client";
    import { QuotaSummaryChips } from "../../src/components/quota-summary-bar/QuotaSummaryBar";
    const t = key => ({ "quotaSummary.openAccounts": "Open account management", "quotaSummary.critical": "90%+ used" })[key] ?? key;
    const rows = Array.from({ length: 8 }, (_, i) => ({
      provider: "fixture-" + i, label: i === 7 ? "Provider with a particularly long configured display name" : i ? "Provider " + i : "opencode go", severity: i === 7 ? "ok" : "critical",
      headline: { id: "weekly", label: "Weekly limit", percent: i === 7 ? 31 : 90, severity: i === 7 ? "ok" : "critical" },
      windows: [{ id: "weekly", label: "Weekly limit", percent: i === 7 ? 31 : 90, severity: i === 7 ? "ok" : "critical" }],
    }));
    createRoot(document.getElementById("root")).render(
      <section className="quota-summary-bar"><QuotaSummaryChips rows={rows} t={t} locale="en" /></section>
    );
  `);
  const build = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
  if (!build.success) throw new AggregateError(build.logs, "Browser fixture failed to bundle");
  const js = await build.outputs.find(file => file.path.endsWith(".js"))!.text();
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${styles.join("\n")}</style>
    <style>body{margin:0;padding-top:40px}${process.argv.includes("--without-bridge") ? ".quota-summary-popover::before{content:none}" : ""}${process.argv.includes("--without-wide-bridge") ? ".quota-summary-popover::before{left:-1px;right:-1px}" : ""}</style></head>
    <body><div id="root"></div><script type="module">${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
  browser = Bun.spawn([chrome, "--headless", "--disable-gpu", "--disable-background-networking",
    "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    ...(process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), "about:blank"],
  { stdout: "ignore", stderr: "ignore" });
  let port = "";
  const deadline = Date.now() + 10_000;
  while (!port && Date.now() < deadline) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch { await delay(50); }
  }
  if (!/^\d+$/.test(port)) throw new Error("Chrome did not expose its debugging port");
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const target = await response.json() as { webSocketDebuggerUrl: string };
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const ws = socket;
  await new Promise<void>((done, fail) => {
    ws.addEventListener("open", () => done(), { once: true });
    ws.addEventListener("error", () => fail(new Error("CDP connection failed")), { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  ws.addEventListener("message", event => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
    else request?.resolve(message.result);
  });
  const cdp = <T = unknown>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve: value => resolve(value as T), reject });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await cdp<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const move = async (x: number, y: number) => {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    // Let React commit before the next real hit test.
    await delay(20);
  };
  const box = (selector: string) => evaluate<{ left: number; right: number; top: number; bottom: number }>(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};
  })()`);
  const assertOpen = async (stage: string) => {
    if (!await evaluate('!!document.querySelector(".quota-summary-popover")')) throw new Error(`Popover closed ${stage}`);
  };
  await cdp("Page.enable");
  const { frameTree } = await cdp<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  await cdp("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
  for (let attempt = 0; !await evaluate('!!document.querySelector(".quota-summary-chip")'); attempt++) {
    if (attempt === 100) throw new Error("React fixture did not mount");
    await delay(25);
  }
  const cases: unknown[] = [];
  for (const theme of ["light", "dark"]) for (const width of [1280, 375, 760, 761]) for (const scale of [1, 1.25, 1.5]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: scale, mobile: false });
    // A fractional layout origin exercises placement rounding as well as display scaling.
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.body.style.paddingTop=${JSON.stringify(`${40 + scale % 1}px`)};`);
    const chips = await evaluate<number>('document.querySelectorAll(".quota-summary-chip").length');
    for (const index of [0, chips - 1]) {
      await move(width / 2, 500);
      const selector = `.quota-summary-item:nth-child(${index + 1}) .quota-summary-chip`;
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"nearest",inline:"nearest"})`);
      const chip = await box(selector);
      const x = (chip.left + chip.right) / 2;
      await move(x, (chip.top + chip.bottom) / 2);
      await assertOpen(`on chip (${theme}/${width}/${scale}/${index})`);
      const popover = await box(".quota-summary-popover");
      const list = await box(".quota-summary-list");
      for (const fraction of [0.01, 0.5, 0.99]) {
        const visibleLeft = Math.max(list.left + 2, chip.left);
        const visibleRight = Math.min(list.right - 2, chip.right);
        const fromX = visibleLeft + (visibleRight - visibleLeft) * fraction;
        const toX = Math.max(popover.left + 4, Math.min(popover.right - 4, fromX));
        await move(fromX, (chip.top + chip.bottom) / 2);
        await assertOpen("on visible chip edge");
        // Sample the gap itself at the edges; the chip's rounded corners exclude its rect corners.
        for (let y = chip.bottom + (fraction === 0.5 ? -0.5 : 0.5); y <= popover.top + 1; y += 0.5) {
          const progress = Math.max(0, Math.min(1, (y - chip.bottom) / (popover.top - chip.bottom)));
          await move(fromX + (toX - fromX) * progress, y);
          await assertOpen(`crossing gap (${theme}/${width}/${scale}/${index}/${fraction}, y=${y})`);
        }
        await move(x, (chip.top + chip.bottom) / 2);
      }
      const foot = await box(".quota-summary-popover-foot");
      await move((foot.left + foot.right) / 2, (foot.top + foot.bottom) / 2);
      await assertOpen("at account-management link");
      if (theme === "dark" && width === 1280 && scale === 1 && index === 0) {
        const screenshot = await cdp<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x:0, y:35, width:500, height:180, scale:1 } });
        await writeFile(join(output, "quota-hover-fixed.png"), Buffer.from(screenshot.data, "base64"));
      }
      await move(x, (chip.top + chip.bottom) / 2);
      await assertOpen("returning to chip");
      const link = await box(".quota-summary-popover-link");
      await move((link.left + link.right) / 2, (link.top + link.bottom) / 2);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp("Input.dispatchMouseEvent", { type, x:(link.left + link.right) / 2, y:(link.top + link.bottom) / 2, button:"left", clickCount:1 });
      }
      await delay(20);
      if (await evaluate('location.hash') !== `#providers?provider=fixture-${index}&tab=accounts`) throw new Error("Account link did not navigate");
      if (await evaluate('!!document.querySelector(".quota-summary-popover")')) throw new Error("Navigation did not close the popover");
      await move(x, (chip.top + chip.bottom) / 2);
      // A resting pointer stays suppressed after navigation; leave and re-enter to reopen.
      await move(width / 2, 500);
      await move(x, (chip.top + chip.bottom) / 2);
      await assertOpen("after re-entering chip");
      await move(width / 2, 500);
      if (await evaluate('!!document.querySelector(".quota-summary-popover")')) throw new Error("Popover stayed open outside item");
      cases.push({ theme, width, scale, index, gap: popover.top - chip.bottom, chipWidth: chip.right - chip.left, popoverWidth: popover.right - popover.left });
    }
  }
  const key = async (key: string, code: number) => {
    for (const type of ["keyDown", "keyUp"]) await cdp("Input.dispatchKeyEvent", { type, key, windowsVirtualKeyCode: code });
    await delay(20);
  };
  await key("Tab", 9);
  await evaluate('document.querySelector(".quota-summary-chip").focus()');
  await delay(20);
  await assertOpen("on keyboard-focused chip");
  await key("Tab", 9);
  if (!await evaluate('document.activeElement.matches(".quota-summary-popover-link")')) throw new Error("Tab did not reach account link");
  await assertOpen("on keyboard-focused link");
  await key("Escape", 27);
  if (!await evaluate('document.activeElement.matches(".quota-summary-chip") && !document.querySelector(".quota-summary-popover")')) throw new Error("Escape did not restore chip focus and dismiss");
  await key("Tab", 9);
  await key("Tab", 9);
  if (!await evaluate('document.activeElement.matches(".quota-summary-popover-link")')) throw new Error("Next chip's account link is unreachable");
  await key("Enter", 13);
  if (await evaluate('location.hash') !== "#providers?provider=fixture-1&tab=accounts") throw new Error("Keyboard account navigation failed");
  await writeFile(join(output, "results.json"), JSON.stringify({ browser: await cdp("Browser.getVersion"), cases }, null, 2));
  console.log(`PASS: ${cases.length} real-pointer cases, account navigation, gap traversal and dismissal; keyboard Tab/Enter/Escape.`);
} finally {
  socket?.close();
  browser?.kill();
  if (browser) await browser.exited;
  await rm(profile, { recursive: true, force: true });
  await rm(fixture, { recursive: true, force: true });
}
