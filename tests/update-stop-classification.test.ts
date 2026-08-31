import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "../src/update/stop-contract.mjs";
import { probeProxyLiveness } from "../src/update/proxy-liveness-probe.mjs";
import { decidePostStopUpdate } from "../src/update/stop-decision.mjs";

const repoRoot = join(import.meta.dir, "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

/**
 * #3008: `ocx update` aborted after a stop that had already succeeded.
 *
 * `handleStop` sets a failure code AFTER history restoration — that is, after the proxy
 * and service are already down — so a failed Codex-history cleanup was indistinguishable
 * from a proxy that refused to die. The update aborted with the service stopped, no
 * listener, and the old package still installed.
 *
 * The distinguishing signal has to survive `spawnSync`, so it is an exit code rather than
 * a type. These assertions pin the contract at both ends of that process boundary, and the
 * decision table each end implements.
 */
describe("stop failure classification (#3008)", () => {
  test("the history-only code is outside every code this CLI already uses", () => {
    // Picking an occupied code would make a history-only stop indistinguishable from
    // whatever else emits it, and `bin/ocx.mjs` mirrors the child's status faithfully
    // enough to propagate the confusion.
    expect(STOP_HISTORY_INCOMPLETE_EXIT_CODE).toBe(79);
    // sysexits.h occupies 64-78; 128+signal starts at 129.
    expect(STOP_HISTORY_INCOMPLETE_EXIT_CODE).toBeGreaterThan(78);
    expect(STOP_HISTORY_INCOMPLETE_EXIT_CODE).toBeLessThan(128);

    const cliCodes = [...read("src/cli/index.ts").matchAll(/process\.exit(?:Code)?\s*(?:=|\()\s*(\d+)/g)]
      .map(match => Number(match[1]));
    const dispatchCodes = [...read("src/cli/dispatch.ts").matchAll(/return (\d+);/g)]
      .map(match => Number(match[1]));
    expect(cliCodes).not.toContain(STOP_HISTORY_INCOMPLETE_EXIT_CODE);
    expect(dispatchCodes).not.toContain(STOP_HISTORY_INCOMPLETE_EXIT_CODE);
  });

  test("the shared contract is plain ESM so the Node launcher can import it", () => {
    // A .ts module would be unusable from bin/ocx.mjs, and inlining the number in two
    // places is how the two ends drift.
    const contract = read("src/update/stop-contract.mjs");
    expect(contract).toContain("export const STOP_HISTORY_INCOMPLETE_EXIT_CODE");
    expect(read("bin/ocx.mjs")).toContain("stop-contract.mjs");
    expect(read("src/update/index.ts")).toContain("stop-contract.mjs");
  });

  test("the liveness probe sees a surviving proxy, and fails open when nothing is there", async () => {
    // Behavioural, not textual: absent PID and runtime files are weak evidence, so the
    // updaters ask the endpoint. The listener runs in a SEPARATE process because the probe
    // uses spawnSync - an in-process server could never answer while the parent's event
    // loop is blocked, which is also why the probe speaks node:http rather than fetch.
    const listener = spawn(process.execPath, ["-e", [
      "const http = require('node:http');",
      "const server = http.createServer((req, res) => {",
      "  if (req.url !== '/healthz') { res.writeHead(404); res.end(); return; }",
      "  res.writeHead(200, { 'content-type': 'application/json' });",
      "  res.end(JSON.stringify({ service: 'opencodex', pid: process.pid, version: 'test' }));",
      "});",
      "server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));",
    ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("listener did not report a port")), 10_000);
      listener.stdout.once("data", chunk => { clearTimeout(timer); resolve(Number(String(chunk))); });
      listener.once("error", error => { clearTimeout(timer); reject(error); });
    });

    try {
      expect(probeProxyLiveness(port)).toBe("live");
    } finally {
      listener.kill();
      await new Promise<void>(resolve => listener.once("exit", () => resolve()));
    }

    // A refused connection is the one error that proves nothing is listening.
    expect(probeProxyLiveness(port)).toBe("dead");
    // Nothing to ask is not ambiguity.
    expect(probeProxyLiveness(0)).toBe("dead");
    expect(probeProxyLiveness(Number.NaN)).toBe("dead");
  });

  test("identity decides live, and an unexpected status is unknown", async () => {
    // Mirrors isOpencodexHealthz: a foreign server exposing /healthz is not our proxy, a
    // pre-identity build of ours is, and any status other than 200 says the endpoint is
    // answering without telling us what it is - which is not evidence of absence.
    const cases: Array<[string, string, "live" | "dead" | "unknown"]> = [
      ["canonical", "{ service: 'opencodex', pid: 1 }", "live"],
      ["legacy pre-identity", "{ status: 'ok', version: '2.0.0', uptime: 12 }", "live"],
      ["foreign", "{ service: 'other', status: 'ok' }", "dead"],
      ["foreign lookalike", "{ status: 'ok' }", "dead"],
    ];
    for (const [name, body, expected] of cases) {
      const listener = spawn(process.execPath, ["-e", [
        "const http = require('node:http');",
        "const server = http.createServer((req, res) => {",
        "  res.writeHead(200, { 'content-type': 'application/json' });",
        `  res.end(JSON.stringify(${body}));`,
        "});",
        "server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));",
      ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name} listener did not report a port`)), 10_000);
        listener.stdout.once("data", chunk => { clearTimeout(timer); resolve(Number(String(chunk))); });
        listener.once("error", error => { clearTimeout(timer); reject(error); });
      });
      try {
        expect(probeProxyLiveness(port)).toBe(expected);
      } finally {
        listener.kill();
        await new Promise<void>(resolve => listener.once("exit", () => resolve()));
      }
    }
  });

  test("a non-200 from our own endpoint is unknown, never dead", async () => {
    const listener = spawn(process.execPath, ["-e", [
      "const http = require('node:http');",
      "const server = http.createServer((req, res) => {",
      "  res.writeHead(500, { 'content-type': 'application/json' });",
      "  res.end(JSON.stringify({ service: 'opencodex' }));",
      "});",
      "server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));",
    ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("listener did not report a port")), 10_000);
      listener.stdout.once("data", chunk => { clearTimeout(timer); resolve(Number(String(chunk))); });
      listener.once("error", error => { clearTimeout(timer); reject(error); });
    });
    try {
      expect(probeProxyLiveness(port)).toBe("unknown");
    } finally {
      listener.kill();
      await new Promise<void>(resolve => listener.once("exit", () => resolve()));
    }
  });

  test("the shared probe normalizes wildcard and bracketed IPv6 hosts", async () => {
    // Normalization lives in the probe, not at each call site: doing it per-lane fixed
    // the npm launcher and left the TypeScript updater passing a bracketed literal
    // straight to node:http, which answers nothing - read as "unknown", which aborts a
    // healthy update and leaves the service down. That is the original failure shape.
    const listener = spawn(process.execPath, ["-e", [
      "const http = require('node:http');",
      "const server = http.createServer((req, res) => {",
      "  res.writeHead(200, { 'content-type': 'application/json' });",
      "  res.end(JSON.stringify({ service: 'opencodex', pid: process.pid }));",
      "});",
      "server.listen(0, () => process.stdout.write(String(server.address().port)));",
    ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("listener did not report a port")), 10_000);
      listener.stdout.once("data", chunk => { clearTimeout(timer); resolve(Number(String(chunk))); });
      listener.once("error", error => { clearTimeout(timer); reject(error); });
    });

    try {
      // A wildcard bind cannot be dialled as a wildcard; it answers on loopback.
      expect(probeProxyLiveness(port, "0.0.0.0")).toBe("live");
      expect(probeProxyLiveness(port, "*")).toBe("live");
      // A URL-spelled literal is unwrapped rather than handed to the socket layer.
      expect(probeProxyLiveness(port, "[127.0.0.1]")).toBe("live");
      // Empty falls back to loopback rather than dialling "".
      expect(probeProxyLiveness(port, "")).toBe("live");
    } finally {
      listener.kill();
      await new Promise<void>(resolve => listener.once("exit", () => resolve()));
    }
  });

  test("an unreachable or silent endpoint is unknown, not dead", async () => {
    // Fail-open was the wrong default: a listener that accepts connections but withholds
    // /healthz, or a probe that times out, is exactly the state where replacing package
    // files is most dangerous. "We could not tell" is not evidence the proxy is gone.
    const listener = spawn(process.execPath, ["-e", [
      "const net = require('node:net');",
      // Accepts the connection and never answers, so the request times out.
      "const server = net.createServer(() => {});",
      "server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));",
    ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("listener did not report a port")), 10_000);
      listener.stdout.once("data", chunk => { clearTimeout(timer); resolve(Number(String(chunk))); });
      listener.once("error", error => { clearTimeout(timer); reject(error); });
    });

    try {
      expect(probeProxyLiveness(port, "127.0.0.1", 400)).toBe("unknown");
    } finally {
      listener.kill();
      await new Promise<void>(resolve => listener.once("exit", () => resolve()));
    }
  });

  test("the shared decision covers the whole post-stop matrix", () => {
    // This is THE predicate both updaters call, not a copy of it: src/update/index.ts and
    // bin/ocx.mjs each import decidePostStopUpdate. Testing a local reimplementation would
    // stay green while either lane drifted, which is how #3008 shipped fixed on one side.
    const dead = { hasRuntimeState: false, liveness: "dead" } as const;

    // Proceed: a clean stop, or the history-only code with everything else quiet.
    expect(decidePostStopUpdate({ status: 0, ...dead })).toEqual({ proceed: true, reason: "ok" });
    expect(decidePostStopUpdate({ status: STOP_HISTORY_INCOMPLETE_EXIT_CODE, ...dead }))
      .toEqual({ proceed: true, reason: "history-only" });

    // Abort: a stop that did not finish. A signal kill carries no evidence that it did.
    for (const status of [1, 2, 4, 64, 130, null]) {
      expect(decidePostStopUpdate({ status, ...dead }))
        .toEqual({ proceed: false, reason: "stop-failed" });
    }

    // Abort: records survived the stop, even on a clean exit.
    expect(decidePostStopUpdate({ status: 0, hasRuntimeState: true, liveness: "dead" }))
      .toEqual({ proceed: false, reason: "runtime-state" });

    // Abort: something still answers as our proxy, or the probe could not tell. Absence of
    // proof is not proof of absence when the cost is a server running mixed modules.
    expect(decidePostStopUpdate({ status: 0, hasRuntimeState: false, liveness: "live" }))
      .toEqual({ proceed: false, reason: "proxy-live" });
    expect(decidePostStopUpdate({ status: 0, hasRuntimeState: false, liveness: "unknown" }))
      .toEqual({ proceed: false, reason: "proxy-unknown" });
    // The history-only code does not buy past a live or unclear proxy either.
    expect(decidePostStopUpdate({ status: STOP_HISTORY_INCOMPLETE_EXIT_CODE, hasRuntimeState: false, liveness: "unknown" }))
      .toEqual({ proceed: false, reason: "proxy-unknown" });
  });

  test("both updater lanes call the shared decision", () => {
    // The reported path is a dashboard npm update through the plain-Node launcher. Fixing
    // only the Bun updater would leave that lane broken while every focused test went
    // green, which is exactly how #3008 reached a release.
    for (const lane of ["src/update/index.ts", "bin/ocx.mjs"]) {
      const source = read(lane);
      expect(source).toContain("decidePostStopUpdate({");
      // And neither lane keeps a private copy of the rule it was supposed to delegate.
      expect(source).not.toMatch(/status !== 0 && !historyOnlyStop/);
    }
  });

  test("handleStop emits the code only for a history-only failure and still returns", () => {
    const cli = read("src/cli/index.ts");
    // Ordinary failure wins: it is the stronger signal.
    expect(cli).toMatch(/if \(stopFailed\) process\.exitCode = 1;\s*\n\s*else if \(historyOnlyFailure\) process\.exitCode = STOP_HISTORY_INCOMPLETE_EXIT_CODE;/);
    // The code is set rather than exited inline so the dispatcher still receives the
    // return value and decides what happens next.
    expect(cli).toMatch(/process\.exitCode = STOP_HISTORY_INCOMPLETE_EXIT_CODE;\s*\n\s*return !stopFailed;/);
    // Config and catalog failures are real teardown failures: a client reads those.
    expect(cli).toMatch(/artifacts\.config\.state === "failed" \|\| artifacts\.catalog\.state === "failed"/);
  });
});
