import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { LINK_CHILD_WS_LIMITS } from "../../src/client/link-websocket-limits";
import { encodeClientText } from "../../src/client/link-ws-framer";
import { rawUpgrade, RawCodex } from "../helpers/link-ws-child";
import { startStandinHome, standinIdentity, type StandinHome } from "../fixtures/link-ws-standin-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

// Memory acceptance for the link WebSocket transport on the Child (design T4 6.3 and 11.2-9), opt-in:
// OCX_LINK_WS_RSS_CHILD_ACCEPTANCE=1. It mirrors the Home's acceptance (tests/e2e-style/link-websocket-rss.test.ts) on
// the Child. The same held load runs twice, each through a fresh Child process (tests/fixtures/link-ws-rss-child.ts): once
// over the link WebSocket and once over the Child's HTTP link relay. Every Codex-side socket (8, the per-Child cap) sends
// a near-8 MiB request and then stops reading. The stand-in Home in this process answers with near-4 MiB events, written
// onto TCP in the Home acceptance's chunk plan (1 byte to 16 MiB), and holds each stream after 16 MiB. The sockets are
// then cut in a seeded random order. Accepted when both Child processes reported their own settled stall, both peaks are
// the kernel's high-water mark, and the WebSocket run's peak over idle minus the HTTP run's stays within the sockets'
// reservations (8 x 32 MiB = 256 MiB).
// The Child's HTTP relay accepts request bodies up to 256 MiB (LINK_RELAY_BODY_MAX_BYTES), so both loads carry the same
// near-8 MiB request; nothing is scaled down. OCX_LINK_WS_RSS_CHILD_SOCKETS (the only other setting) makes the run a
// diagnostic that prints its numbers and asserts no budget. A child process runs the Child: the bound is this file's
// default.

const ENABLED = process.env.OCX_LINK_WS_RSS_CHILD_ACCEPTANCE === "1";
const SOCKETS = Number(process.env.OCX_LINK_WS_RSS_CHILD_SOCKETS ?? LINK_CHILD_WS_LIMITS.openSockets);
const DIAGNOSTIC_SETTINGS = ["OCX_LINK_WS_RSS_CHILD_SOCKETS"].filter(name => process.env[name] !== undefined);
const CANONICAL = DIAGNOSTIC_SETTINGS.length === 0;
const MiB = 1024 * 1024;
const EVENT_BYTES = Math.floor(3.9 * MiB);
const CHUNK_PLAN = [1, 64 * 1024, 16 * MiB, MiB, 4 * MiB, 1, 16 * MiB];
const HOLD_BYTES = 16 * MiB;
const INPUT_BYTES = LINK_CHILD_WS_LIMITS.localMessageBytes - 64 * 1024;
const CLOSE_DEADLINE_MS = 30_000;
setDefaultTimeout(600_000);

const eventJson = (index: number, delta: string) => JSON.stringify({ type: "response.output_text.delta", index, delta });
const COMPLETED = '{"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}';

/** Server (unmasked) text frames for 14 near-4 MiB events and the terminal: what a Home sends on a link socket. */
function wsBody(): Buffer {
  const delta = "x".repeat(EVENT_BYTES - 200);
  const frame = (text: string): Buffer => {
    const payload = Buffer.from(text, "utf8");
    const head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2);
    return Buffer.concat([head, payload]);
  };
  return Buffer.concat([...Array.from({ length: 14 }, (_, index) => frame(eventJson(index, delta))), frame(COMPLETED)]);
}

/** The same events as an SSE body: what a Home sends to a relayed HTTP request. */
function sseBody(): Buffer {
  const delta = "x".repeat(EVENT_BYTES - 200);
  return Buffer.from(Array.from({ length: 14 }, (_, index) => "event: response.output_text.delta\ndata: " + eventJson(index, delta) + "\n\n").join("")
    + "event: response.completed\ndata: " + COMPLETED + "\n\n", "utf8");
}

/** Writes `body` in the chunk plan's slices, up to the hold point (or all of it); each slice through `write`. */
function writePlanned(body: Buffer, write: (slice: Buffer) => void, hold: boolean): void {
  let offset = 0;
  for (let pulls = 0; offset < body.length; pulls += 1) {
    if (hold && offset >= HOLD_BYTES) return;
    const size = CHUNK_PLAN[pulls % CHUNK_PLAN.length]!;
    const slice = body.subarray(offset, Math.min(body.length, offset + size));
    offset += slice.length;
    write(slice);
  }
}

type StallSync = "child-legs-paused" | "child-relays-waiting";
interface LoadResult { method: string; idle: number; peak: number; delta: number; sync: StallSync }

async function runLoad(transport: "websocket" | "http"): Promise<LoadResult> {
  expect(SOCKETS).toBeGreaterThan(0);
  expect(SOCKETS).toBeLessThanOrEqual(LINK_CHILD_WS_LIMITS.openSockets);
  const root = mkdtempSync(join(tmpdir(), "ocx-link-ws-rss-child-"));
  const identity = standinIdentity();
  let warm = true;
  const loadSockets: Socket[] = [];
  // The request bytes the Home received per load request: the HTTP body, or the WebSocket create's text.
  const homeBodies: number[] = [];
  const ws = wsBody(); const sse = sseBody();
  const home: StandinHome = await startStandinHome({
    identity,
    // A relayed POST /v1/responses: the warm-up gets a whole short answer, a load request the held SSE stream. Either is
    // answered only once the whole declared body has arrived, as the WebSocket side answers only a complete create.
    stream: (request, socket, rest) => {
      if (request.method !== "POST" || !request.path.startsWith("/v1/responses")) return false;
      const isWarm = warm;
      const declared = Number(request.headers.get("content-length"));
      let received = rest.length;
      let answered = false;
      const arrived = (): void => {
        if (answered || !(Number.isInteger(declared) && received >= declared)) return;
        answered = true;
        if (!isWarm) homeBodies.push(received);
        respond(socket, isWarm);
      };
      socket.on("data", chunk => { received += chunk.length; arrived(); });
      if (!Number.isInteger(declared)) { homeBodies.push(Number.NaN); respond(socket, isWarm); return true; }
      arrived();
      return true;
    },
  });
  function respond(socket: Socket, isWarm: boolean): void {
    socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n");
    const chunk = (bytes: Buffer) => socket.write(Buffer.concat([Buffer.from(bytes.length.toString(16) + "\r\n"), bytes, Buffer.from("\r\n")]));
    if (isWarm) { chunk(Buffer.from("event: response.completed\ndata: " + COMPLETED + "\n\n")); socket.write("0\r\n\r\n"); }
    else { loadSockets.push(socket); writePlanned(sse, chunk, true); }
  }
  // Link sockets: the warm-up gets the terminal at once, a load socket the held frames once its create has arrived.
  void (async () => {
    for (;;) {
      const socket = await home.nextSocket();
      const isWarm = warm;
      void socket.until(frame => frame.type === "text").then(frame => {
        if (!frame) return;
        if (isWarm) { socket.sendText(COMPLETED); return; }
        if (frame.type === "text") homeBodies.push(Buffer.byteLength(frame.data));
        loadSockets.push(socket.socket);
        writePlanned(ws, slice => socket.raw(slice), true);
      });
    }
  })();
  const child = Bun.spawn(["bun", repoPath("tests/fixtures/link-ws-rss-child.ts")], {
    cwd: repoPath(), stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { ...process.env, OPENCODEX_HOME: join(root, "child-home") },
  });
  const reader = child.stdout.getReader();
  let pending = "";
  const nextLine = async (): Promise<Record<string, number | boolean | string>> => {
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.startsWith("{")) return JSON.parse(line) as Record<string, number | boolean | string>;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("Child fixture exited");
      pending += new TextDecoder().decode(value);
    }
  };
  const ask = async (command: string): Promise<number> => { child.stdin.write(command + "\n"); child.stdin.flush(); return Number((await nextLine()).rss); };
  const clients: Socket[] = [];
  try {
    child.stdin.write(JSON.stringify({ homePort: home.port, identity, transport, stalls: SOCKETS }) + "\n");
    child.stdin.flush();
    const ready = await nextLine();
    expect(ready.preflight).toBe("ok");
    const port = Number(ready.port);
    // Warm-up, one whole turn on each transport with a near-maximum input (as the Home acceptance warms), so one-time
    // first-request costs land before "idle".
    const { socket: warmSocket, answer } = rawUpgrade(port);
    const warmAnswer = await answer;
    expect(warmAnswer.status).toBe(101);
    const warmCodex = new RawCodex(warmSocket, warmAnswer.rest);
    warmSocket.write(encodeClientText(JSON.stringify({ type: "response.create", model: "fixture/fixture", input: "y".repeat(INPUT_BYTES), stream: true })));
    expect(await warmCodex.until(event => event.type === "text" && event.data.includes("response.completed"))).not.toBeNull();
    warmSocket.destroy();
    const warmHttp = await fetch("http://127.0.0.1:" + port + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/fixture", input: "y".repeat(INPUT_BYTES), stream: true }) });
    expect(await warmHttp.text()).toContain("response.completed");
    warm = false;
    child.stdin.write("gc-rss\n"); child.stdin.flush();
    const idleAnswer = await nextLine();
    if (idleAnswer.invalid === true) throw new Error("invalid run: " + JSON.stringify(idleAnswer));
    const idle = Number(idleAnswer.rss);
    // No wait is open at the idle reading: the warm-up turns have ended theirs.
    expect(idleAnswer.waitingAtIdle).toBe(0);
    const body = JSON.stringify({ type: "response.create", model: "fixture/fixture", input: "y".repeat(INPUT_BYTES), stream: true });
    for (let index = 0; index < SOCKETS; index += 1) {
      if (transport === "websocket") {
        const { socket, answer: upgraded } = rawUpgrade(port);
        clients.push(socket);
        expect((await upgraded).status).toBe(101);
        socket.write(encodeClientText(body));
        socket.pause();
      } else {
        const post = JSON.stringify({ model: "fixture/fixture", input: "y".repeat(INPUT_BYTES), stream: true });
        const socket = connect({ host: "127.0.0.1", port });
        clients.push(socket);
        await new Promise<void>(resolve => socket.once("connect", () => resolve()));
        socket.write("POST /v1/responses HTTP/1.1\r\nhost: 127.0.0.1:" + port + "\r\ncontent-type: application/json\r\ncontent-length: " + Buffer.byteLength(post) + "\r\n\r\n" + post);
        socket.pause();
      }
    }
    // The Child itself announces the settled stall: every leg paused (WebSocket) or every relayed response waiting for its
    // reader (HTTP). The deadline and a reader the load does not own fail the run; neither ever passes it.
    let settled: Record<string, number | boolean | string> = {};
    for (;;) {
      const line = await nextLine();
      if (line.stalled === true) { settled = line; break; }
      if (line.settleFailed === true) throw new Error("the load did not settle: " + JSON.stringify(line));
      if (line.invalid === true) throw new Error("invalid run: " + JSON.stringify(line));
    }
    let seed = 7;
    const order = clients.map((client, index) => ({ client, key: (seed = (seed * 48271) % 2147483647) + index }));
    for (const { client } of order.sort((a, b) => a.key - b.key)) client.destroy();
    // The Child processes the cut before the peak is read (the Home acceptance's order): every Home-side connection of the
    // load closes from the Child's side (its legs and relays); they are destroyed only in finally.
    // Bounded: a Child that never closes its side fails the run here, and finally still stops it.
    let closeBound: ReturnType<typeof setTimeout> | undefined;
    const closedAll = await Promise.race([
      Promise.all(loadSockets.map(socket => socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve())))).then(() => true),
      new Promise<boolean>(resolve => { closeBound = setTimeout(() => resolve(false), CLOSE_DEADLINE_MS); }),
    ]);
    clearTimeout(closeBound);
    if (!closedAll) throw new Error("the Child did not close " + loadSockets.filter(socket => !socket.closed).length + " Home connections within " + CLOSE_DEADLINE_MS + " ms of the cut");
    child.stdin.write("peak\n"); child.stdin.flush();
    const peakAnswer = await nextLine();
    const peak = peakAnswer.rss === null ? Number.NaN : Number(peakAnswer.rss);
    // From the idle reading through the peak, never more waits than the load has and never a wait ending that was not open.
    expect({ maxWaiting: peakAnswer.maxWaiting, minWaiting: peakAnswer.minWaiting }).toEqual({ maxWaiting: SOCKETS, minWaiting: 0 });
    // The Home received each load request whole before it answered: the same request on both transports.
    const requestBytes = transport === "websocket" ? Buffer.byteLength(body) : Buffer.byteLength(JSON.stringify({ model: "fixture/fixture", input: "y".repeat(INPUT_BYTES), stream: true }));
    expect(homeBodies).toEqual(Array.from({ length: SOCKETS }, () => requestBytes));
    const method = String(peakAnswer.method);
    const after = await ask("gc-rss");
    const deltaBytes = peak - idle;
    console.log(JSON.stringify({ method, transport, sockets: SOCKETS, idleMiB: idle / MiB, peakMiB: peak / MiB, deltaMiB: deltaBytes / MiB, perSocketMiB: deltaBytes / SOCKETS / MiB,
      budgetMiB: SOCKETS * LINK_CHILD_WS_LIMITS.socketReservationBytes / MiB, quietWindowMs: settled.quietWindowMs, settleMs: settled.settleMs, afterCutMiB: after / MiB, inputBytes: INPUT_BYTES }));
    return { method, idle, peak, delta: deltaBytes, sync: transport === "websocket" ? "child-legs-paused" : "child-relays-waiting" };
  } finally {
    for (const client of clients) client.destroy();
    for (const socket of loadSockets) socket.destroy();
    try { child.stdin.write("stop\n"); child.stdin.flush(); child.stdin.end(); } catch { /* already gone */ }
    child.kill();
    await child.exited;
    await home.stop();
    removeTreeWithRetry(root);
  }
}

const LINUX = process.platform === "linux";
describe.skipIf(!ENABLED || !LINUX)("link WebSocket transport-only RSS acceptance on the Child"
  + (!ENABLED ? " [skipped: opt-in with OCX_LINK_WS_RSS_CHILD_ACCEPTANCE=1; it runs two Child processes under a held load and is not part of the ordinary suite]"
    : !LINUX ? " [skipped: Linux only; the peak is the kernel's VmHWM, and elsewhere the acceptance cannot pass]" : ""), () => {
  test.skipIf(!CANONICAL)("acceptance: the WebSocket's peak RSS over the HTTP relay's, under the same held load, stays within the Child's link socket reservations"
    + (CANONICAL ? "" : " [skipped: diagnostic settings present (" + DIAGNOSTIC_SETTINGS.join(", ") + ")]"), async () => {
    const websocket = await runLoad("websocket");
    const http = await runLoad("http");
    for (const result of [websocket, http]) {
      expect(result.method).toBe("kernel-vmhwm");
      expect(Number.isFinite(result.peak) && result.peak >= result.idle).toBe(true);
    }
    const budget = SOCKETS * LINK_CHILD_WS_LIMITS.socketReservationBytes;
    console.log(JSON.stringify({ acceptance: true, sockets: SOCKETS, websocketSync: websocket.sync, httpSync: http.sync, websocketMinusHttpMiB: (websocket.delta - http.delta) / MiB, budgetMiB: budget / MiB }));
    expect({ websocket: websocket.sync, http: http.sync }).toEqual({ websocket: "child-legs-paused", http: "child-relays-waiting" });
    expect(websocket.delta - http.delta).toBeLessThanOrEqual(budget);
  });

  test.skipIf(CANONICAL)("diagnostic run, never an acceptance: " + (CANONICAL ? "none requested" : DIAGNOSTIC_SETTINGS.join(", ")), async () => {
    const websocket = await runLoad("websocket");
    const http = await runLoad("http");
    console.log(JSON.stringify({ diagnostic: true, sockets: SOCKETS, websocketMinusHttpMiB: (websocket.delta - http.delta) / MiB }));
  });
});
