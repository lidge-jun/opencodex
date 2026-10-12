/** Rendered regression for Usage's nested table scroller and screen-reader captions.
 * Run with an active browser-skill Agent Window: BSK_SESSION=<id> bun tests/usage-scroll-browser.ts
 * Uses the real source stylesheets and synthetic rows; never connects to a user's proxy.
 * Unlike happy-dom, the browser measures overflow from absolutely positioned descendants.
 */
import { resolve, sep } from "node:path";

const session = process.env.BSK_SESSION;
if (!session) throw new Error("Set BSK_SESSION to an active browser-skill Agent Window session.");
const src = resolve(import.meta.dir, "../src");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("<!doctype html><title>Usage scroll regression</title>", {
      headers: { "content-type": "text/html" },
    });
    if (url.pathname === "/fixture") {
      const count = url.searchParams.get("rows") === "long" ? 40 : 2;
      const rows = Array.from({ length: count }, (_, i) => `<tr>
        <td>model-${i}</td><td>Provider</td><td>Share</td>
        ${"<td>12345</td>".repeat(8)}
        <td><span class="usage-hit-rate">94%</span><span class="sr-only">Cache detail coverage for model ${i}</span></td>
      </tr>`).join("");
      return new Response(`<!doctype html><html><head><meta charset="utf-8">
        <link rel="stylesheet" href="/styles.css"></head><body><div id="root"><div class="app">
        <aside class="sidebar">Navigation</aside><main class="main"><div class="main-inner">
        <div class="usage-workspace-shell"><section class="usw-section">
        <h2>Models</h2><div class="tbl-wrap"><table class="tbl usage-models-tbl">
        <thead><tr>${"<th>Column</th>".repeat(12)}</tr></thead><tbody>${rows}</tbody></table></div>
        </section><section class="usw-section" style="height:300px"><h2>Coverage</h2></section>
        </div></div></main></div></div></body></html>`, { headers: { "content-type": "text/html" } });
    }
    const filePath = resolve(src, `.${url.pathname}`);
    if (filePath.startsWith(`${src}${sep}`) && filePath.endsWith(".css")) {
      const file = Bun.file(filePath);
      if (await file.exists()) return new Response(file);
    }
    return new Response("Not found", { status: 404 });
  },
});

async function browser(command: string, ...args: string[]) {
  const process = Bun.spawn(["bsk", command, ...args, "--session", session!], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  return stdout;
}

try {
  await browser("navigate", server.url.href);
  const results = JSON.parse(await browser("evaluate", `(async () => {
    const results = [];
    for (const width of [1280, 390]) for (const rows of ['short', 'long']) {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'width:' + width + 'px;height:750px;border:0';
      frame.src = '/fixture?rows=' + rows;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Fixture load timed out')), 5000);
        frame.onload = () => { clearTimeout(timeout); resolve(); };
        document.body.append(frame);
      });
      const d = frame.contentDocument, w = frame.contentWindow;
      const main = d.querySelector('main'), wrap = d.querySelector('.tbl-wrap');
      // A short report may naturally end above the viewport bottom; only scrolling
      // beyond that initial end (or the viewport for long reports) is blank overflow.
      const expectedBottom = Math.min(w.innerHeight, main.getBoundingClientRect().bottom);
      d.body.scrollTop = d.body.scrollHeight;
      d.documentElement.scrollTop = d.documentElement.scrollHeight;
      const blankBeyondMain = Math.max(0, expectedBottom - main.getBoundingClientRect().bottom);
      wrap.scrollTop = wrap.scrollHeight;
      const lastRow = d.querySelector('tbody tr:last-child').getBoundingClientRect();
      const bounds = wrap.getBoundingClientRect();
      const lastRowReachable = lastRow.bottom <= bounds.bottom + 1 && lastRow.top >= bounds.top;
      const captionsPresent = d.querySelectorAll('.sr-only').length === (rows === 'long' ? 40 : 2);
      const tableScrolls = rows !== 'long' || wrap.scrollTop > 0;
      results.push({ width, rows, blankBeyondMain, lastRowReachable, captionsPresent, tableScrolls,
        pass: blankBeyondMain <= 1 && lastRowReachable && captionsPresent && tableScrolls });
      frame.remove();
    }
    return { results, pass: results.every(result => result.pass) };
  })()`));
  console.log(JSON.stringify(results, null, 2));
  if (results.pass !== true) process.exitCode = 1;
} finally {
  server.stop(true);
}
