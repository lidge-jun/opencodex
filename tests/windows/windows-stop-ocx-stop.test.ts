/**
 * Plain ocx stop (no consent snapshot) on Windows (#7771, 030 "Two parts"), through the real
 * CLI module graph in tests/fixtures/parent-stop-runner.ts with the platform simulated and
 * Part A / Part B answered by fixtures. Nothing reaches schtasks, PowerShell or FFI.
 *
 * A Part A outcome other than stopped/absent holds the child stop: no /api/stop POST,
 * ownershipBlocked, the shared teardown skipped, and the record says service failed (or
 * state-unknown), proxy unknown, outcome failed. After a stopped Part A, Part B replaces the
 * respawn re-poll; the receipt the POST carries already records Part A.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fixturePath, repoPath } from "../helpers/repo-root";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-windows-plain-stop-")); });
afterEach(() => { removeTreeWithRetry(home); });

const restored = { success: true, message: "native Codex restored",
  artifacts: { config: { state: "restored" }, catalog: { state: "restored" }, history: { state: "restored" } } };

function runStop(windowsPartA: string | undefined, windowsPartB?: string, extra: Record<string, unknown> = {}) {
  const child = spawnSync(process.execPath, [fixturePath("parent-stop-runner.ts")], {
    cwd: repoPath(), env: { ...process.env, OPENCODEX_HOME: home },
    input: JSON.stringify({ receipt: true, json: true, response: { success: true, sharedTeardown: "deferred" },
      restore: restored, ...(windowsPartA ? { windowsPartA } : {}), ...(windowsPartB ? { windowsPartB } : {}), ...extra }),
    encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
  expect(child.error, child.stderr).toBeUndefined();
  const reportPath = join(home, "parent-stop-result.json");
  expect(existsSync(reportPath), child.stderr).toBe(true);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    calls: { native: number; grok: number; service: number; partB: number };
    /** The timeout each reclaimListenPort call asked for; #7771 makes a skipped legacy wait visible. */
    reclaimTimeouts: number[];
    urls: string[]; unexpectedIo: string[]; nonce?: string; receiptExists: boolean; postPartA: unknown[];
  };
  expect(report.unexpectedIo, child.stderr).toEqual([]);
  const lines = child.stdout.trim().split("\n");
  const summary = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  return { ...report, summary, exitCode: child.status, stderr: child.stderr };
}

describe("plain ocx stop on Windows: Part A holds the child stop", () => {
  for (const guarded of [false, true]) {
    test(`receipt failure holds the ${guarded ? "guarded" : "plain"} child stop`, () => {
      const run = runStop("stopped", "freed", { receipt: false, guarded, windowsGuarded: guarded });
      expect(run.urls).toEqual([]);
      expect(run.calls.native).toBe(0);
      expect(run.calls.grok).toBe(0);
      expect(run.exitCode).toBe(1);
    });
  }
  test("a rejected Part A holds the child and shared teardown", () => {
    const run = runStop(undefined, undefined, { windowsPartAReject: true });
    expect(run.urls).toEqual([]);
    expect(run.calls.native).toBe(0);
    expect(run.calls.grok).toBe(0);
    expect(run.exitCode).toBe(1);
    expect(run.summary).toMatchObject({ outcome: "failed", service: "error", proxy: "unknown", sharedTeardown: "skipped" });
  });
  for (const [outcome, service, reason] of [
    ["denied", "failed", "access-denied"],
    ["survived", "failed", undefined],
    ["unknown", "state-unknown", "evidence-unreadable"],
    ["unverified-budget", "failed", "unverified-budget"],
  ] as const) {
    test(`${outcome}: no POST, ownership blocked, shared teardown skipped`, () => {
      const run = runStop(outcome);
      expect(run.calls.service, run.stderr).toBe(1);
      expect(run.urls, run.stderr).toEqual([]);
      expect(run.calls.partB).toBe(0);
      expect(run.calls.native).toBe(0);
      expect(run.calls.grok).toBe(0);
      expect(run.nonce).toBeUndefined();
      expect(run.exitCode).toBe(1);
      expect(run.summary).toMatchObject({ schema: "ocx-stop/1", outcome: "failed", service, proxy: "unknown", sharedTeardown: "skipped" });
      if (reason) expect(run.summary.serviceStopReason).toBe(reason);
      else expect("serviceStopReason" in run.summary).toBe(false);
      expect(run.stderr).toContain("The proxy was left running and the shared teardown skipped");
    });
  }
});

describe("plain ocx stop on Windows: Part B after a stopped Part A", () => {

  test("stopped WinSW and own wrapper: unknown and no POST", () => {
    const run = runStop(undefined, undefined, { windowsPartAUnderOwnWrapper: true, windowsWinswStopped: true });
    expect(run.urls).toEqual([]);
    expect(run.calls.native).toBe(0);
    expect(run.exitCode).toBe(1);
    expect(run.summary).toMatchObject({ service: "state-unknown", proxy: "unknown", sharedTeardown: "skipped" });
  });

  test("under this home's wrapper with nothing registered: unknown, no POST, no shared teardown", () => {
    // The real Part A refuses: this stop runs under this home's .cmd/.vbs wrapper and no
    // service is registered. Reading that as absent would stop the child and restore shared
    // config beneath a wrapper that can relaunch the proxy.
    const run = runStop(undefined, undefined, { windowsPartAUnderOwnWrapper: true });
    expect(run.calls.service, run.stderr).toBe(1);
    expect(run.urls, run.stderr).toEqual([]);
    expect(run.calls.partB).toBe(0);
    expect(run.calls.native).toBe(0);
    expect(run.calls.grok).toBe(0);
    expect(run.nonce).toBeUndefined();
    expect(run.exitCode).toBe(1);
    expect(run.summary).toMatchObject({ outcome: "failed", service: "state-unknown", proxy: "unknown", sharedTeardown: "skipped", serviceStopReason: "evidence-unreadable" });
    expect(run.stderr).toContain("this stop runs under this home's service wrapper");
  });

  test("freed: the POST's receipt records Part A, then the restore runs and the receipt clears", () => {
    const run = runStop("stopped", "freed");
    // Part B owns the port wait: stopProxy's legacy 15 s wait must not run on top of it.
    expect(run.reclaimTimeouts, run.stderr).toEqual([]);
    expect(run.urls, run.stderr).toHaveLength(1);
    expect(run.postPartA).toEqual([{ partA: "stopped", manager: { scheduler: true, winsw: false }, wrappers: [{ pid: 30, startTime: 5_100 }] }]);
    expect(run.calls.partB).toBe(1);
    expect(run.calls.native).toBe(1);
    expect(run.receiptExists).toBe(false);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.summary).toMatchObject({ outcome: "stopped", service: "stopped", proxy: "stopped", portHeldByForeign: false });
  });

  test("our identity back on the port: respawned, shared teardown skipped, the receipt kept", () => {
    const run = runStop("stopped", "survived");
    expect(run.urls).toHaveLength(1);
    expect(run.calls.native).toBe(0);
    expect(run.receiptExists).toBe(true);
    expect(run.exitCode).toBe(1);
    expect(run.summary).toMatchObject({ outcome: "failed", proxy: "respawned", sharedTeardown: "skipped", portHeldByForeign: false });
  });

  test("a foreign listener: the stop succeeds and says so", () => {
    const run = runStop("stopped", "port-held-by-foreign");
    expect(run.calls.native).toBe(1);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.summary).toMatchObject({ outcome: "stopped", portHeldByForeign: true });
  });

  test("an unconfirmed port: failed with evidence-unreadable, nothing restored", () => {
    const run = runStop("stopped", "unknown");
    expect(run.calls.native).toBe(0);
    expect(run.exitCode).toBe(1);
    expect(run.summary).toMatchObject({ outcome: "failed", proxy: "unknown", serviceStopReason: "evidence-unreadable" });
  });

  test("guarded: Part B owns the port wait, so the legacy 15 s wait never runs", () => {
    // The guarded path's Part B runs after settle; keying the skip to the snapshotless
    // flag alone left the approved endpoint's 15 s waitForStoppedPort on top of it.
    const run = runStop("stopped", "freed", { guarded: true, windowsGuarded: true });
    expect(run.reclaimTimeouts, run.stderr).toEqual([]);
    expect(run.calls.partB).toBe(1);
    expect(run.urls).toHaveLength(1);
    expect(run.exitCode, run.stderr).toBe(0);
  });

  test("guarded: our identity back on the port still holds the shared teardown", () => {
    // A surviving listener never reaches the forced-kill fallback either: the guarded step
    // reports manager-still-active and nothing is restored.
    const run = runStop("stopped", "survived", { guarded: true, windowsGuarded: true });
    expect(run.reclaimTimeouts, run.stderr).toEqual([]);
    expect(run.calls.native).toBe(0);
    expect(run.calls.killed).toBe(0);
    expect(run.exitCode).toBe(1);
    expect(run.summary).toMatchObject({ outcome: "manager-still-active", proxy: "unknown", sharedTeardown: "skipped" });
  });

  test("absent: today's stop, the POST without Part B and without the 6 s hold", () => {
    const run = runStop("absent");
    expect(run.urls).toHaveLength(1);
    expect(run.postPartA).toEqual([{ partA: "absent", manager: { scheduler: false, winsw: false }, wrappers: [] }]);
    expect(run.calls.partB).toBe(0);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.summary).toMatchObject({ outcome: "stopped", service: "absent" });
    expect("portHeldByForeign" in run.summary).toBe(false);
  });
});
