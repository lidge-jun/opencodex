import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "../src/update/stop-contract.mjs";
import { proxyStillAnswering } from "../src/update/proxy-liveness-probe.mjs";

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

  test("both updaters decode the code, not just the TypeScript one", () => {
    // The reported path is a dashboard npm update, which runs through the plain-Node
    // launcher. Fixing only the Bun updater would have left the reporter's lane broken
    // while every focused test went green.
    for (const lane of ["src/update/index.ts", "bin/ocx.mjs"]) {
      const source = read(lane);
      expect(source).toContain("STOP_HISTORY_INCOMPLETE_EXIT_CODE");
      // Proceed for the history-only code...
      expect(source).toMatch(/historyOnlyStop\s*=\s*stop(?:Res)?\.status === STOP_HISTORY_INCOMPLETE_EXIT_CODE/);
      // ...and only then; any other nonzero status still aborts.
      expect(source).toMatch(/status !== 0 && !historyOnlyStop/);
      // A signal kill leaves status null, which is not 0 and not the history code, so the
      // same expression aborts on it.
      expect(source).not.toMatch(/status !== 0 \|\| historyOnlyStop/);
    }
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
      "  res.end(JSON.stringify({ pid: process.pid, version: 'test' }));",
      "});",
      "server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));",
    ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("listener did not report a port")), 10_000);
      listener.stdout.once("data", chunk => { clearTimeout(timer); resolve(Number(String(chunk))); });
      listener.once("error", error => { clearTimeout(timer); reject(error); });
    });

    try {
      expect(proxyStillAnswering(port)).toBe(true);
    } finally {
      listener.kill();
      await new Promise<void>(resolve => listener.once("exit", () => resolve()));
    }

    // Fails open: the port is closed now, and a probe that cannot answer must not block an
    // update on its own uncertainty - the PID and runtime-file gates are still in force.
    expect(proxyStillAnswering(port)).toBe(false);
    expect(proxyStillAnswering(0)).toBe(false);
    expect(proxyStillAnswering(Number.NaN)).toBe(false);
  });

  test("the decision expression admits only the history code", () => {
    // The two lanes share one predicate shape, so this evaluates that shape directly over
    // the whole status domain rather than pattern-matching the source. A stop that did not
    // finish must never reach the install, and a signal kill (null) carries no evidence
    // that it did.
    const proceeds = (status: number | null): boolean => {
      const historyOnlyStop = status === STOP_HISTORY_INCOMPLETE_EXIT_CODE;
      return !((status !== 0 && !historyOnlyStop));
    };
    expect(proceeds(0)).toBe(true);
    expect(proceeds(STOP_HISTORY_INCOMPLETE_EXIT_CODE)).toBe(true);
    expect(proceeds(1)).toBe(false);
    expect(proceeds(2)).toBe(false);
    expect(proceeds(4)).toBe(false);
    expect(proceeds(64)).toBe(false);
    expect(proceeds(130)).toBe(false);
    expect(proceeds(null)).toBe(false);
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
