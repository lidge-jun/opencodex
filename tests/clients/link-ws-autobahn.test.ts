import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { HomeLeg, type LinkWebsocketTimers } from "../../src/client/link-websocket";
import { LINK_CHILD_WS_LIMITS } from "../../src/client/link-websocket-limits";
import { validLinkUpgradeAnswer } from "../../src/client/link-ws-transport";
import { fixturePath } from "../helpers/repo-root";

// The Autobahn fuzzingserver client conformance run for the Child's Home-facing link WebSocket leg (design T4 3.3,
// R2-06; a condition of the Child's release gate, src/client/link-websocket-limits.ts). Opt-in: it runs only when
// OCX_LINK_WS_AUTOBAHN_URL names a running fuzzingserver (for example http://127.0.0.1:9001) and
// OCX_LINK_WS_AUTOBAHN_REPORTS names the host directory the server writes its reports to.
//
// What is under test is the code the relay runs against a Home: the Child's own upgrade answer check
// (validLinkUpgradeAnswer), then a real HomeLeg (frame reader, masked client frames, ping answers, close handshake,
// message and fragment limits) on a node:net socket. The fuzzingserver plays the Home. In place of Codex, an echo stub
// hands every text message the leg delivers back through leg.fromCodex, one at a time, waiting for the socket to
// flush, as Codex sends one request at a time. Each case is judged against tests/fixtures/link-ws-autobahn-expectations.json.
// The fuzzingserver is an external process: the bound is this file's default, not a per-test timeout.
setDefaultTimeout(1_800_000);

const BASE = process.env.OCX_LINK_WS_AUTOBAHN_URL ?? "";
const REPORTS = process.env.OCX_LINK_WS_AUTOBAHN_REPORTS ?? "";
const ENABLED = BASE !== "" && REPORTS !== "";
const AGENT = "ocx-child-link-leg";

interface Rule { cases: string[]; expect: "pass" | "unimplemented" | { closeCode: number }; why: string }
const EXPECT = JSON.parse(readFileSync(fixturePath("link-ws-autobahn-expectations.json"), "utf8")) as { rules: Rule[] };
const timers: LinkWebsocketTimers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
const wsBase = () => BASE.replace(/^http/, "ws");

/** A control endpoint of the fuzzingserver (getCaseCount, updateReports), on Bun's own WebSocket: not under test. */
function control(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase() + path);
    let text = "";
    ws.onmessage = event => { text += String(event.data); };
    ws.onclose = () => resolve(text);
    ws.onerror = () => reject(new Error("fuzzingserver control " + path + " failed"));
  });
}

/** One case through the Child's leg; resolves with the leg's end reason once the connection has closed. */
function runCase(index: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE);
    const socket: Socket = connect({ host: url.hostname, port: Number(url.port) });
    const key = randomBytes(16).toString("base64");
    socket.once("error", error => reject(error));
    socket.write("GET /runCase?case=" + index + "&agent=" + AGENT + " HTTP/1.1\r\nHost: " + url.host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n");
    let buffered = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onHead);
      const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) { const colon = line.indexOf(":"); if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim(); }
      const statusCode = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? "")?.[1]);
      if (!validLinkUpgradeAnswer({ statusCode, headers } as never, key)) { socket.destroy(); reject(new Error("case " + index + ": the Child refused the server's 101")); return; }
      let reason = "none";
      const queue: string[] = [];
      let flushing = false; let closed = false;
      const pump = () => {
        if (flushing || closed) return;
        const next = queue.shift();
        if (next === undefined) return;
        flushing = true;
        leg.fromCodex(next);
        const done = () => { flushing = false; pump(); };
        if (socket.writableLength === 0) queueMicrotask(done); else socket.once("drain", done);
      };
      const leg = new HomeLeg(socket, Buffer.from(buffered.subarray(end + 4)), LINK_CHILD_WS_LIMITS, timers,
        () => ({ toHome() {}, fromHome() {}, uncounted() {}, end() {} }),
        why => { reason = why; }, () => resolve(reason));
      leg.attach({
        send: (data: string | Bun.BufferSource) => { if (typeof data === "string") { queue.push(data); queueMicrotask(pump); } return 1; },
        close: () => { closed = true; },
        getBufferedAmount: () => 0,
      });
    };
    socket.on("data", onHead);
  });
}

function matches(pattern: string, id: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return id.startsWith(pattern.slice(0, -1));
  return id === pattern;
}

describe.skipIf(!ENABLED)("link WebSocket Child leg: Autobahn fuzzingserver client conformance (design 3.3)"
  + (ENABLED ? "" : " [skipped: set OCX_LINK_WS_AUTOBAHN_URL and OCX_LINK_WS_AUTOBAHN_REPORTS to a running fuzzingserver]"), () => {
  test("every case lands in the class its reviewed expectation names", async () => {
    const count = Number(await control("/getCaseCount"));
    expect(count).toBeGreaterThan(0);
    const ends: Record<string, number> = {};
    for (let index = 1; index <= count; index++) {
      const reason = await runCase(index);
      ends[reason] = (ends[reason] ?? 0) + 1;
    }
    await control("/updateReports?agent=" + AGENT);
    const index = JSON.parse(readFileSync(join(REPORTS, "clients", "index.json"), "utf8")) as Record<string, Record<string, { behavior: string; behaviorClose: string; remoteCloseCode: number | null }>>;
    const results = index[AGENT] ?? {};
    expect(Object.keys(results).length).toBe(count);
    const mismatches: string[] = [];
    const byClass: Record<string, number> = {};
    for (const [id, result] of Object.entries(results)) {
      const rule = EXPECT.rules.find(candidate => candidate.cases.some(pattern => matches(pattern, id)))!;
      const want = rule.expect;
      let ok: boolean;
      if (want === "pass") ok = ["OK", "NON-STRICT", "INFORMATIONAL"].includes(result.behavior) && ["OK", "INFORMATIONAL"].includes(result.behaviorClose);
      else if (want === "unimplemented") ok = ["UNIMPLEMENTED", "OK", "NON-STRICT", "INFORMATIONAL"].includes(result.behavior);
      else ok = result.remoteCloseCode === want.closeCode;
      const label = typeof want === "string" ? want : "close " + want.closeCode;
      byClass[label + (ok ? "" : " MISMATCH")] = (byClass[label + (ok ? "" : " MISMATCH")] ?? 0) + 1;
      if (!ok) mismatches.push(id + ": expected " + label + ", got " + result.behavior + "/" + result.behaviorClose + " close " + result.remoteCloseCode);
    }
    console.info("[autobahn] " + JSON.stringify({ cases: count, byClass, legEnds: ends }));
    expect(mismatches).toEqual([]);
  });
});
