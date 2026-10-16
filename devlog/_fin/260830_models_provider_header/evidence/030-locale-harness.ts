const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const t = list.find((x: any) => x.type === "page");
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = () => r(null); });
let id = 0; const pend = new Map<number, (v: any) => void>();
ws.onmessage = (e: any) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id); } };
const send = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
await send("Page.enable"); await send("Runtime.enable");

const PROBE = `(() => {
  const de = document.documentElement;
  const cards = [...document.querySelectorAll('.models-provider-card')];
  const lefts = cards.map(c => { const a = c.querySelector('.models-provider-actions'); return a ? a.getBoundingClientRect().left : 0; });
  return {
    scrollW: de.scrollWidth, clientW: de.clientWidth, hOverflow: de.scrollWidth > de.clientWidth,
    spread: +(Math.max(...lefts) - Math.min(...lefts)).toFixed(1),
    worstOvf: +Math.max(...cards.map(c => { const a = c.querySelector('.models-provider-actions'); return a ? a.getBoundingClientRect().right - c.getBoundingClientRect().right : -99; })).toFixed(1),
    zeroW: cards.reduce((n, c) => { const a = c.querySelector('.models-provider-actions'); return n + (a ? [...a.children].filter(k => k.getBoundingClientRect().width < 6).length : 0); }, 0),
    maxHeadH: +Math.max(...cards.map(c => c.querySelector('.models-provider-head').getBoundingClientRect().height)).toFixed(1),
    labelText: [...document.querySelectorAll('.switch-labeled-text')].slice(0,2).map(e => e.textContent.trim()),
  };
})()`;

// Korean and German are the long-label cases the reviewer will ask about.
const rows: any[] = [];
for (const loc of ["ko", "de", "en"]) {
  await send("Page.navigate", { url: "http://127.0.0.1:10787/#models" });
  await new Promise((r) => setTimeout(r, 2500));
  await ev("localStorage.setItem('ocx-lang', " + JSON.stringify(loc) + ")");
  await send("Page.reload", { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 5000));
  for (const width of [780, 1024, 1280, 1440]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 968, deviceScaleFactor: 2, mobile: false });
    await new Promise((r) => setTimeout(r, 1200));
    rows.push({ loc, width, ...(await ev(PROBE)) });
  }
  await send("Emulation.clearDeviceMetricsOverride");
}
ws.close();
console.log("loc  w     scrollW clientW ovf?  worstOvf spread zeroW headH  label");
for (const r of rows) {
  console.log(r.loc.padEnd(4) + String(r.width).padEnd(6) + String(r.scrollW).padEnd(8) + String(r.clientW).padEnd(8) + String(r.hOverflow).padEnd(6) + String(r.worstOvf).padEnd(9) + String(r.spread).padEnd(7) + String(r.zeroW).padEnd(6) + String(r.maxHeadH).padEnd(7) + JSON.stringify(r.labelText));
}
await Bun.write("/tmp/ocx-probe/locale-sweep.json", JSON.stringify(rows, null, 2));
