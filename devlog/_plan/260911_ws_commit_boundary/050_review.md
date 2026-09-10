# wp4 review — xai/grok-4.6 read-only diff review (agent 01a08e96)

Verdict received: FAIL with two majors and one minor.

| # | severity | finding | disposition |
|---|---|---|---|
| 1 | major | commitResponse bailing on terminal leaves the non-metadata body-error path unsettled (failStream sets terminal first, then calls commitResponse, then controller.error with no resolve). | ACCEPTED, real bug. commitResponse guards only responseCommitted again; the JSON settle path sets responseCommitted = true before resolving so a second 200 can never be committed. |
| 2 | major | bun-types WebSocketEventMap lists only close/error/message/open, so a client pong event may never reach onPong; ping-alive would be harness-only. | REBUTTED with a runtime probe. Bun 1.4.0 (the minimum version the bounded relay gate accepts) was probed on 2026-09-11 with a local Bun.serve websocket and a client new WebSocket: ws.ping is a function, ws.pong is a function, and addEventListener("pong") fired with the ping payload (seen: open, pong:x, message:ack). The type map is incomplete; the runtime dispatches the event. The exchange still feature-detects ping() and degrades to the message-only 90 s bound where no pong arrives, which is exactly the never-pongs oracle. Probe script kept below. |
| 3 | minor | The never-pongs oracle used one 90 s jump and relied on recursive fake-timer scheduling. | ACCEPTED. The test now steps 15 s at a time like its sibling. |

Findings 4-6 were confirmations (harness oracles, TypeScript after a00ef49af7, privacy of the JSON body).

## Probe (not product code, run once in /tmp)

```js
const srv = Bun.serve({ port: 0, fetch(req, s){ if (s.upgrade(req)) return; return new Response("no"); },
  websocket: { open(ws){}, message(ws,m){ if (m==="hi") ws.send("ack"); }, ping(ws,data){ }, pong(ws,data){ } } });
const ws = new WebSocket("ws://127.0.0.1:"+srv.port);
const seen = [];
for (const ev of ["open","message","close","error","ping","pong"]) ws.addEventListener(ev, e => seen.push(ev + (e.data!==undefined? ":"+String(e.data):"")));
await new Promise(r => ws.addEventListener("open", r, {once:true}));
ws.ping("x"); ws.send("hi"); await new Promise(r => setTimeout(r, 400));
console.log(JSON.stringify({ bun: Bun.version, ping: typeof ws.ping, pong: typeof ws.pong, seen }));
```

Output: {"bun":"1.4.0","ping":"function","pong":"function","seen":["open","pong:x","message:ack"]}

