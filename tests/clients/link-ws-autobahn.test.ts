import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { HomeLeg, type LinkWebsocketTimers } from "../../src/client/link-websocket";
import { LINK_CHILD_WS_LIMITS } from "../../src/client/link-websocket-limits";
import { validLinkUpgradeAnswer } from "../../src/client/link-ws-transport";
import { fixturePath } from "../helpers/repo-root";

// The Autobahn fuzzingserver client conformance run for the Child's Home-facing link WebSocket leg (design T4 3.3,
// R2-06; a condition of the Child's release gate, src/client/link-websocket-limits.ts). Opt-in: it runs only when
// OCX_LINK_WS_AUTOBAHN_URL names a running fuzzingserver on loopback (any other host is refused) and
// OCX_LINK_WS_AUTOBAHN_REPORTS names the host directory the server writes its reports to. The recorded run is
// tests/fixtures/link-ws-autobahn/run.sh: the pinned image, the spec next to it (every case), published on
// 127.0.0.1:9001 only.
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
// One of the two set is a misconfigured run, not an opt-out: it fails and names the missing variable.
const PARTIAL = (BASE !== "") !== (REPORTS !== "");
// A fresh agent name per run: the verdict is read from this run's own report, never from an earlier one in the same directory.
const AGENT = "ocx-child-link-leg-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
const EXPECTATIONS_FILE = fixturePath("link-ws-autobahn-expectations.json");

interface Rule { cases: string[]; expect: "pass" | "unimplemented" | { closeCode: number }; why: string }
const EXPECTATIONS_TEXT = readFileSync(EXPECTATIONS_FILE, "utf8");
const EXPECT = JSON.parse(EXPECTATIONS_TEXT) as { caseCount: number; limits: { homeMessageBytes: number; maxFragments: number }; rules: Rule[] };
const timers: LinkWebsocketTimers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
const wsBase = () => BASE.replace(/^http/, "ws");

/** A control endpoint of the fuzzingserver (getCaseCount, updateReports), on Bun's own WebSocket: not under test. */
function control(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase() + path);
    let text = "";
    ws.onmessage = event => { text += String(event.data); };
    // Only a close frame ends a control exchange: 1000, or 1005 (the fuzzingserver closes these without a code). A
    // connection that ended without one (1006) or any other code fails the run.
    ws.onclose = event => { if (event.code === 1000 || event.code === 1005) resolve(text); else reject(new Error("fuzzingserver control " + path + " closed " + event.code)); };
    ws.onerror = () => reject(new Error("fuzzingserver control " + path + " failed"));
  });
}

/** One case through the Child's leg; resolves with the leg's end reason once the connection has closed. */
function runCase(index: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE);
    // URL.hostname keeps an IPv6 literal in brackets ([::1]); node:net wants it bare.
    const socket: Socket = connect({ host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(url.port) });
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

test.skipIf(!PARTIAL)("the Autobahn run is configured completely (both OCX_LINK_WS_AUTOBAHN_URL and OCX_LINK_WS_AUTOBAHN_REPORTS)", () => {
  throw new Error("set " + (BASE ? "OCX_LINK_WS_AUTOBAHN_REPORTS" : "OCX_LINK_WS_AUTOBAHN_URL") + " too: one without the other runs nothing");
});

interface CaseReport {
  behavior: string; behaviorClose: string; remoteCloseCode: number | null; wasClean: boolean;
  wasCloseHandshakeTimeout: boolean; wasOpenHandshakeTimeout: boolean; wasServerConnectionDropTimeout: boolean;
  rxFrameStats: Record<string, number>;
}

describe.skipIf(!ENABLED)("link WebSocket Child leg: Autobahn fuzzingserver client conformance (design 3.3)"
  + (ENABLED ? "" : " [skipped: set OCX_LINK_WS_AUTOBAHN_URL and OCX_LINK_WS_AUTOBAHN_REPORTS to a running fuzzingserver]"), () => {
  test("every case lands in the class its reviewed expectation names", async () => {
    // The server is a local fixture: a fuzzingserver anywhere else is not the recorded run.
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(BASE).hostname);
    const count = Number(await control("/getCaseCount"));
    // The 1009 rules are written for the Child's own limits: the file states them, and they must be the Child's.
    expect(EXPECT.limits).toEqual({ homeMessageBytes: LINK_CHILD_WS_LIMITS.homeMessageBytes, maxFragments: LINK_CHILD_WS_LIMITS.maxFragments });
    // The case set is pinned: the image's suite has exactly the cases the expectations were reviewed against.
    expect(count).toBe(EXPECT.caseCount);
    const ends: Record<string, number> = {};
    for (let index = 1; index <= count; index++) {
      const reason = await runCase(index);
      ends[reason] = (ends[reason] ?? 0) + 1;
    }
    await control("/updateReports?agent=" + AGENT);
    const index = JSON.parse(readFileSync(join(REPORTS, "clients", "index.json"), "utf8")) as Record<string, Record<string, { reportfile: string }>>;
    // This run's agent only: a report left in the directory by an earlier run has another agent name.
    const results = index[AGENT] ?? {};
    expect(Object.keys(results).length).toBe(count);
    const mismatches: string[] = [];
    const byClass: Record<string, number> = {};
    for (const [id, entry] of Object.entries(results)) {
      const report = JSON.parse(readFileSync(join(REPORTS, "clients", entry.reportfile), "utf8")) as CaseReport;
      const rule = EXPECT.rules.find(candidate => candidate.cases.some(pattern => matches(pattern, id)))!;
      const want = rule.expect;
      // The close itself, for every class: completed cleanly, with no handshake or connection-drop timeout.
      const cleanClose = report.wasClean && !report.wasCloseHandshakeTimeout && !report.wasOpenHandshakeTimeout && !report.wasServerConnectionDropTimeout;
      let ok: boolean;
      if (want === "pass") ok = ["OK", "NON-STRICT", "INFORMATIONAL"].includes(report.behavior) && ["OK", "INFORMATIONAL"].includes(report.behaviorClose) && cleanClose;
      else if (want === "unimplemented") ok = report.behavior === "UNIMPLEMENTED" && report.behaviorClose === "OK" && cleanClose;
      else {
        // A refusal: the expected close code, nothing but a close frame received from the Child (no echoed or other
        // application data before it), and a clean close. Autobahn itself reports these as FAILED: it expected an echo.
        // Fail closed: a report without frame statistics cannot show that nothing was sent.
        const stats = report.rxFrameStats;
        const statsValid = typeof stats === "object" && stats !== null && Object.values(stats).every(n => typeof n === "number") && (stats["8"] ?? 0) >= 1;
        const dataFrames = statsValid ? Object.entries(stats).filter(([opcode]) => Number(opcode) < 8).reduce((sum, [, n]) => sum + n, 0) : -1;
        ok = statsValid && report.remoteCloseCode === want.closeCode && dataFrames === 0 && cleanClose;
      }
      const label = typeof want === "string" ? want : "close " + want.closeCode;
      byClass[label + (ok ? "" : " MISMATCH")] = (byClass[label + (ok ? "" : " MISMATCH")] ?? 0) + 1;
      if (!ok) mismatches.push(id + ": expected " + label + ", got " + report.behavior + "/" + report.behaviorClose + " close " + report.remoteCloseCode
        + " clean " + report.wasClean + " frames from the Child " + JSON.stringify(report.rxFrameStats));
    }
    // Every rule names cases that exist: a rule that matches nothing is a stale or mistyped expectation.
    const unused = EXPECT.rules.filter(rule => !Object.keys(results).some(id => rule.cases.some(pattern => matches(pattern, id))));
    expect(unused.map(rule => rule.cases.join(","))).toEqual([]);
    const expectationsSha256 = createHash("sha256").update(EXPECTATIONS_TEXT).digest("hex");
    console.info("[autobahn] " + JSON.stringify({ agent: AGENT, server: BASE, cases: count, expectationsSha256, byClass, legEnds: ends }));
    expect(mismatches).toEqual([]);
  });
});
