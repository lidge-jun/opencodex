
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const t = list.find((x) => x.type === "page" && String(x.url).includes("10787")) || list.find(x=>x.type==="page");
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = () => r(null); });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m,p={}) => new Promise((res) => { const i = ++id; pend.set(i,res); ws.send(JSON.stringify({id:i,method:m,params:p})); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: "http://127.0.0.1:10787/#models" });
await new Promise(r=>setTimeout(r,6000));
await ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/모두 펼치기|Expand all/.test(x.textContent||''));if(b)b.click();})()");
await new Promise(r=>setTimeout(r,2500));
const OP = "getComputedStyle(document.querySelector('.models-alias-edit')).opacity";
const park = async () => { await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:2,y:2}); await ev("document.activeElement&&document.activeElement.blur()"); await new Promise(r=>setTimeout(r,700)); };
const out = {};
await park(); out.rest_pointerAway = await ev(OP);
// Touch: the hover/pointer media features come from DEVICE emulation, not
// setEmulatedMedia — setting them as media features leaves matchMedia false.
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await new Promise(r=>setTimeout(r,900));
out.touch_matchMedia = await ev("matchMedia('(hover: none)').matches");
out.touch_pointerCoarse = await ev("matchMedia('(pointer: coarse)').matches");
out.touch_opacity = await ev(OP);
await send("Emulation.clearDeviceMetricsOverride");
await send("Emulation.setTouchEmulationEnabled", { enabled: false });
await new Promise(r=>setTimeout(r,700));
await park(); out.back_to_rest = await ev(OP);
// Reduced motion keeps the emphasis and drops only the animation.
await send("Emulation.setEmulatedMedia", { media: "screen", features: [{name:"prefers-reduced-motion",value:"reduce"}] });
await new Promise(r=>setTimeout(r,700));
out.reducedMotion = await ev("getComputedStyle(document.querySelector('.models-alias-edit')).transitionDuration + ' / opacity ' + " + OP);
await send("Emulation.setEmulatedMedia", { media: "", features: [] });
console.log(JSON.stringify(out,null,2));
await Bun.write("/tmp/ocx-probe/wp2-touch.json", JSON.stringify(out,null,2));
ws.close();
