// Baseline geometry harness for the Models provider group-head.
// Full CDP (Emulation domain) via agbrowse's Chrome on 127.0.0.1:9222.
const WIDTHS = [780, 1280, 1440];
const URL_ = "http://localhost:10100/#models";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
let target = list.find((t: any) => t.type === "page");
if (!target) {
  // PUT is required by newer Chrome for /json/new.
  const res = await fetch("http://127.0.0.1:9222/json/new?" + encodeURIComponent(URL_), { method: "PUT" });
  target = await res.json();
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = () => res(null); ws.onerror = rej; });

let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (ev: any) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
};
function send(method: string, params: any = {}): Promise<any> {
  const myId = ++id;
  return new Promise((res) => { pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
}
async function evaluate(expr: string) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.error) throw new Error(JSON.stringify(r.error));
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: URL_ });
await new Promise((r) => setTimeout(r, 4500));

const PROBE = `(() => {
  const de = document.documentElement;
  const cards = [...document.querySelectorAll('.models-provider-card')];
  return {
    inner: innerWidth,
    scrollW: de.scrollWidth,
    clientW: de.clientWidth,
    hOverflow: de.scrollWidth > de.clientWidth,
    cards: cards.map(card => {
      const acts = card.querySelector('.models-provider-actions');
      const nm = card.querySelector('.models-provider-toggle span');
      const kids = acts ? [...acts.children] : [];
      const ar = acts ? acts.getBoundingClientRect() : null;
      const cr = card.getBoundingClientRect();
      return {
        name: nm ? nm.textContent.trim() : '?',
        n: kids.length,
        kinds: kids.map(c => String(c.className).replace('btn btn-ghost btn-sm', 'btn').trim().slice(0, 22)),
        actsLeft: ar ? +ar.left.toFixed(1) : -1,
        overflowRight: ar ? +(ar.right - cr.right).toFixed(1) : -1,
        zeroWidth: kids.filter(c => c.getBoundingClientRect().width < 6).length,
      };
    }),
  };
})()`;

const results: any[] = [];
for (const width of WIDTHS) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 968, deviceScaleFactor: 2, mobile: false });
  await new Promise((r) => setTimeout(r, 1500));
  results.push({ width, ...(await evaluate(PROBE)) });
}
await send("Emulation.clearDeviceMetricsOverride");
ws.close();

for (const r of results) {
  console.log("=== width " + r.width + " inner=" + r.inner + " scrollW=" + r.scrollW + " clientW=" + r.clientW + " hOverflow=" + r.hOverflow);
  for (const c of r.cards) {
    console.log("  " + c.name.padEnd(20) + " n=" + c.n + " left=" + String(c.actsLeft).padStart(7) + " ovf=" + String(c.overflowRight).padStart(6) + " zero=" + c.zeroWidth + "  [" + c.kinds.join(" | ") + "]");
  }
}
await Bun.write("/tmp/ocx-probe/baseline.json", JSON.stringify(results, null, 2));
console.log("\nwrote /tmp/ocx-probe/baseline.json");
