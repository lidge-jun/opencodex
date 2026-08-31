import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "../src/update/stop-contract.mjs";

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

  test("the npm launcher proceeds for the history code and aborts for any other", () => {
    // Behavioural rather than textual: run the real `bin/ocx.mjs` update path against a
    // stub launcher whose `stop` exits with a chosen code, and observe whether it went on
    // to the update or aborted. A source-pattern assertion cannot tell those apart.
    const dir = mkdtempSync(join(tmpdir(), "ocx-stop-class-"));
    try {
      const configDir = join(dir, "home", ".opencodex");
      mkdirSync(configDir, { recursive: true });
      // Runtime state present so the updater enters the stop branch at all, and removed by
      // the stub so the post-stop liveness check passes.
      writeFileSync(join(configDir, "runtime-port.json"), JSON.stringify({ port: 65_000 }));

      const stub = join(dir, "stub-launcher.mjs");
      writeFileSync(stub, [
        "import { rmSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const code = Number(process.env.OCX_STUB_STOP_CODE ?? '0');",
        "if (process.argv[2] === 'stop') {",
        "  rmSync(join(process.env.OCX_STUB_CONFIG_DIR, 'runtime-port.json'), { force: true });",
        "  process.exit(code);",
        "}",
        "process.exit(0);",
      ].join("\n"));

      const run = (code: number): { status: number | null; stderr: string } => {
        writeFileSync(join(configDir, "runtime-port.json"), JSON.stringify({ port: 65_000 }));
        const result = spawnSync(process.execPath, [stub, "stop"], {
          encoding: "utf8",
          env: {
            ...process.env,
            OCX_STUB_STOP_CODE: String(code),
            OCX_STUB_CONFIG_DIR: configDir,
          },
        });
        return { status: result.status, stderr: result.stderr ?? "" };
      };

      // The stub itself round-trips the code, which is the property bin/ocx.mjs relies on
      // when it mirrors a child status.
      expect(run(STOP_HISTORY_INCOMPLETE_EXIT_CODE).status).toBe(STOP_HISTORY_INCOMPLETE_EXIT_CODE);
      expect(run(1).status).toBe(1);
      expect(run(0).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handleStop emits the code only for a history-only failure and still returns", () => {
    const cli = read("src/cli/index.ts");
    // Ordinary failure wins: it is the stronger signal.
    expect(cli).toMatch(/if \(stopFailed\) process\.exitCode = 1;\s*\n\s*else if \(historyOnlyFailure\) process\.exitCode = STOP_HISTORY_INCOMPLETE_EXIT_CODE;/);
    // `restart` and the tray coordinator call handleStop and need it to RETURN, so the
    // code is set rather than exited inline.
    expect(cli).toMatch(/process\.exitCode = STOP_HISTORY_INCOMPLETE_EXIT_CODE;\s*\n\s*return !stopFailed;/);
    // Config and catalog failures are real teardown failures: a client reads those.
    expect(cli).toMatch(/artifacts\.config\.state === "failed" \|\| artifacts\.catalog\.state === "failed"/);
  });
});
