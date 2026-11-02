import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { helperPath } from "../helpers/repo-root";

function run(home: string, mode: string) {
  const result = Bun.spawnSync([process.execPath, helperPath("codex-affinity-restart-worker.ts"), mode], {
    env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("pool binding and issuer survive a clean restart", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-restart-"));
  try {
    const first = run(home, "write");
    expect(first.exit, first.stderr).toBe(0);
    const second = run(home, "read");
    expect(second.exit, second.stderr).toBe(0);
    const before = JSON.parse(first.stdout);
    const after = JSON.parse(second.stdout);
    expect(after.account).toBe(before.account);
    expect(after.issuer).toBe(before.account);
    expect(after.sameScrub).toBe(false);
    expect(after.otherScrub).toBe(true);
    expect(after.otherFileRefusal).toBe(400);
  } finally { removeTreeWithRetry(home); }
});

test("an unclean owner discards persisted affinity", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-crash-"));
  try {
    const first = run(home, "crash");
    expect(first.exit).not.toBe(0);
    const second = run(home, "read");
    expect(second.exit, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).issuer).toBeUndefined();
    expect(JSON.parse(second.stdout).account).toBe("b");
  } finally { removeTreeWithRetry(home); }
});

test("unknown issuer scrubs continuation without refusing files, while retry moves are refused", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-unknown-"));
  try {
    const first = run(home, "unknown-write");
    expect(first.exit, first.stderr).toBe(0);
    const second = run(home, "unknown-read");
    expect(second.exit, second.stderr).toBe(0);
    const result = JSON.parse(second.stdout);
    expect(result.issuer).toBe("__unknown_codex_conversation_state_issuer__");
    expect(result.sameScrub).toBe(true);
    expect(result.fileRefusal).toBeUndefined();
    expect(result.retryRefusal).toBe(400);
    expect(result.otherFileRefusal).toBeUndefined();
  } finally { removeTreeWithRetry(home); }
});

test("a replacement identity invalidates the old pin and makes its issuer unknown", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-relogin-"));
  try {
    const first = run(home, "relogin");
    expect(first.exit, first.stderr).toBe(0);
    const second = run(home, "read");
    expect(second.exit, second.stderr).toBe(0);
    const before = JSON.parse(first.stdout);
    const after = JSON.parse(second.stdout);
    expect(after.account).not.toBe(before.account);
    expect(after.issuer).toBe("__unknown_codex_conversation_state_issuer__");
  } finally { removeTreeWithRetry(home); }
});
