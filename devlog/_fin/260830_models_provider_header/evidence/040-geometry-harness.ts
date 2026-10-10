
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const t = list.find((x) => x.type === "page") ;
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = () => r(null); });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m,p={}) => new Promise((res) => { const i = ++id; pend.set(i,res); ws.send(JSON.stringify({id:i,method:m,params:p})); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable"); await send("Runtime.enable");

const PROBE = `(() => {
  const de = document.documentElement;
  const cards = [...document.querySelectorAll('.models-provider-card')];
  const acts = c => c.querySelector('.models-provider-actions');
  const lefts = cards.map(c => acts(c) ? acts(c).getBoundingClientRect().left : 0);
  const clusters = [...document.querySelectorAll('.models-cap-cluster')];
  return {
    scrollW: de.scrollWidth, clientW: de.clientWidth, hOverflow: de.scrollWidth > de.clientWidth,
    cards: cards.length,
    cardClip: Math.max(...cards.map(c => c.scrollWidth - c.clientWidth)),
    clusterClip: clusters.length ? Math.max(...clusters.map(c => c.scrollWidth - c.clientWidth)) : -1,
    capSlotAll: cards.length > 0 && cards.every(c => !!c.querySelector('.models-cap-cluster .custom-select')),
    clustersFound: clusters.length,
    spread: +(Math.max(...lefts) - Math.min(...lefts)).toFixed(1),
    zeroW: cards.reduce((n, c) => n + (acts(c) ? [...acts(c).children].filter(k => k.getBoundingClientRect().width < 6).length : 0), 0),
    maxHeadH: +Math.max(...cards.map(c => c.querySelector('.models-provider-head').getBoundingClientRect().height)).toFixed(1),
  };
})()`;
const rows = [];
for (const loc of ["ko","de","en"]) {
  await send("Page.navigate", { url: "http://127.0.0.1:10787/#models" });
  await new Promise(r=>setTimeout(r,3000));
  await ev("localStorage.setItem('ocx-lang'," + JSON.stringify(loc) + ")");
  await send("Page.reload", {});
  await new Promise(r=>setTimeout(r,5500));
  await ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/모두 펼치기|Expand all|Alle aufklappen/.test(x.textContent||''));if(b)b.click();})()");
  await new Promise(r=>setTimeout(r,2000));
  for (const width of [780,1024,1280,1440]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 968, deviceScaleFactor: 2, mobile: false });
    await new Promise(r=>setTimeout(r,1300));
    rows.push({ loc, width, ...(await ev(PROBE)) });
  }
  await send("Emulation.clearDeviceMetricsOverride");
}
ws.close();
console.log("loc  w     ovf?  cardClip clusterClip capSlotAll clusters spread zeroW headH");
for (const r of rows) console.log(r.loc.padEnd(4)+String(r.width).padEnd(6)+String(r.hOverflow).padEnd(6)+String(r.cardClip).padEnd(9)+String(r.clusterClip).padEnd(12)+String(r.capSlotAll).padEnd(11)+String(r.clustersFound).padEnd(9)+String(r.spread).padEnd(7)+String(r.zeroW).padEnd(6)+r.maxHeadH);
await Bun.write("/tmp/ocx-probe/wp3-geometry.json", JSON.stringify(rows,null,2));

