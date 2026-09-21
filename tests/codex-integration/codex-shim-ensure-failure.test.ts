/**
 * #5261: the Codex autostart shim must never hide a failed autostart, and must never be the
 * reason Codex does not launch.
 *
 * It used to do both. Both of `ocx ensure`'s streams were discarded and its exit status ignored
 * with `|| true`, so a proxy that failed to come up was completely silent while Codex launched
 * against injected routing pointing at a dead port. These run the real generated script against
 * a stand-in `ensure` rather than asserting on template text, because the property under test is
 * what the shell does with the exit status, not what the file says.
 *
 * Lives beside `codex-shim.test.ts` rather than inside it: that file sits close to its line cap,
 * and the cap only moves down.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnixCodexShim } from "../../src/codex/shim";
import { CODEX_SHIM_ENSURE_FAILED_DIAGNOSTIC } from "../../src/codex/shim-templates";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";

/** The shim refuses to re-enter itself, so a nested test run must not inherit its guard state. */
function cleanShimEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OCX_SHIM_BYPASS: "" };
  delete env.OCX_SHIM_ACTIVE_PID;
  delete env.OCX_SHIM_ACTIVE_DEPTH;
  delete env.OCX_SHIM_PROBE_ACTIVE;
  return env;
}

/**
 * A shim whose `ensure` is `script`. The real Codex prints a marker and exits 7, so every case
 * can tell whether Codex ran and whether its exit status survived the wrapper.
 */
function shimWithEnsure(dir: string, script: string): string {
  const realCodex = join(dir, "codex-real");
  writeFileSync(realCodex, "#!/bin/sh\necho codex-ran\nexit 7\n");
  chmodSync(realCodex, 0o755);
  const fakeBun = join(dir, "fake-bun");
  writeFileSync(fakeBun, script);
  chmodSync(fakeBun, 0o755);
  const wrapper = join(dir, "codex");
  writeFileSync(wrapper, buildUnixCodexShim(realCodex, fakeBun, join(dir, "cli.ts"), "process", join(dir, "absent-token")));
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function runShim(wrapper: string) {
  return spawnSync("/bin/sh", [wrapper, "exec", "hello"], {
    encoding: "utf8",
    env: cleanShimEnv(),
    timeout: INTERNAL_DEADLINE_MS,
  });
}

describe.skipIf(process.platform === "win32")("Codex shim autostart failure (#5261)", () => {
  test("a failed ensure is reported once on stderr and Codex still launches", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-ensure-fail-"));
    try {
      // Writes to both streams so the assertions below also prove ensure's own chatter
      // stays discarded: leaking it would put noise in front of every Codex launch.
      const wrapper = shimWithEnsure(dir, "#!/bin/sh\necho ensure-stdout\necho ensure-stderr >&2\nexit 1\n");
      const run = runShim(wrapper);

      expect(run.error).toBeUndefined();
      expect(run.stdout).toContain("codex-ran");
      expect(run.status).toBe(7);
      expect(run.stderr).toContain(CODEX_SHIM_ENSURE_FAILED_DIAGNOSTIC);
      expect(run.stderr).not.toContain("ensure-stderr");
      expect(run.stdout).not.toContain("ensure-stdout");

      // Once, not once per stream or per retry.
      const occurrences = run.stderr.split(CODEX_SHIM_ENSURE_FAILED_DIAGNOSTIC).length - 1;
      expect(occurrences).toBe(1);
    } finally {
      removeTreeWithRetry(dir);
    }
  }, SPAWN_BUDGET_MS);

  test("a successful ensure says nothing at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-ensure-ok-"));
    try {
      const wrapper = shimWithEnsure(dir, "#!/bin/sh\necho ensure-stdout\nexit 0\n");
      const run = runShim(wrapper);

      expect(run.stdout).toContain("codex-ran");
      expect(run.status).toBe(7);
      expect(run.stderr).not.toContain(CODEX_SHIM_ENSURE_FAILED_DIAGNOSTIC);
      expect(run.stdout).not.toContain("ensure-stdout");
    } finally {
      removeTreeWithRetry(dir);
    }
  }, SPAWN_BUDGET_MS);

  test("an ensure that cannot be executed at all is still not a lockout", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-ensure-missing-"));
    try {
      // The launcher path does not exist. This is the headless/broken-install shape, and the
      // wrapper must treat it exactly like a failed start rather than dying with it.
      const realCodex = join(dir, "codex-real");
      writeFileSync(realCodex, "#!/bin/sh\necho codex-ran\nexit 7\n");
      chmodSync(realCodex, 0o755);
      const wrapper = join(dir, "codex");
      writeFileSync(wrapper, buildUnixCodexShim(realCodex, join(dir, "no-such-bun"), join(dir, "cli.ts"), "process", join(dir, "absent-token")));
      chmodSync(wrapper, 0o755);

      const run = runShim(wrapper);
      expect(run.stdout).toContain("codex-ran");
      expect(run.status).toBe(7);
      expect(run.stderr).toContain(CODEX_SHIM_ENSURE_FAILED_DIAGNOSTIC);
    } finally {
      removeTreeWithRetry(dir);
    }
  }, SPAWN_BUDGET_MS);
});
