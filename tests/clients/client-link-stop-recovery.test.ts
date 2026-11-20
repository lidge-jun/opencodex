import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePath, repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { runStop } from "../helpers/client-link-stop";

async function runRecovery(mode: string, scheduled = false, env = process.env, attempt = 0): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "ocx-link-stop-recovery-"));
  const child = Bun.spawn([process.execPath, fixturePath("client-link-stop-recovery-runner.ts")], {
    cwd: repoPath(), stdin: new Blob([JSON.stringify({ mode, scheduled })]), stdout: "pipe", stderr: "pipe",
    env: { ...env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: join(root, "ocx"), CODEX_HOME: join(root, "codex"),
      OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(root, "claude-desktop"), OCX_SERVICE: "", OCX_SERVICE_MANAGED: "0" },
  });
  let parentDeadlineReached = false;
  const timeout = setTimeout(() => {
    if (child.exitCode !== null) return;
    parentDeadlineReached = true;
    child.kill("SIGKILL");
  }, 15_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit === 75 && stderr.trim() === "fixture-port-collision") {
      if (attempt >= 2) throw new Error("recovery fixture port collided three times");
      return runRecovery(mode, scheduled, env, attempt + 1);
    }
    if (exit !== 0) {
      const phases = stdout.split(/\r?\n/).filter(line => line.startsWith("recovery phase "));
      const status = parentDeadlineReached ? "parent requested termination at its 15s deadline" : "child exited";
      throw new Error([`Link recovery (${mode}): ${status}, exit ${exit}`,
        ...(phases.length ? phases : ["no fixture phase reported"]), stderr.trimEnd()].filter(Boolean).join("\n"));
    }
    expect(stderr).not.toContain("uncaughtException");
    const line = stdout.split("\n").find(line => line.startsWith("{"));
    expect(line, stdout + stderr).toBeDefined();
    return JSON.parse(line!);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    removeTreeWithRetry(root);
  }
}

for (const mode of ["parent", "signal"]) for (const scheduled of [false, true]) {
  test(`a refused ${mode} stop permits completed disconnect recovery through ${scheduled ? "scheduled recycle" : "bound restart"}`, async () => {
    const result = await runRecovery(mode, scheduled);
    expect(result).toMatchObject({ beforeRecoveryAdmission: 409, role: "standalone", spawned: 1,
      file: { userSetting: "keep" }, state: "disconnected", token: "absent", phase: "complete", runtimePresent: false });
    if (mode === "parent") expect(result).toMatchObject({ stopRefused: true, activeAdmission: 409, finishedMarker: false });
    if (!scheduled) expect(result.recoveryAdmission).toBe(202);
  }, 20_000);
}

for (const mode of ["parent-active", "parent-unverified", "parent-malformed", "parent-malformed-start", "signal-active", "pending", "foreign-owner", "wrong-token", "corrupt-receipt", "missing-config", "new-connection", "pending-connect"]) {
  test(`retained stop refuses disconnect recycle while ${mode}`, async () => {
    const result = await runRecovery(mode);
    expect(result).toMatchObject({ beforeRecoveryAdmission: 409, recoveryAdmission: 409, role: "client", spawned: 0,
      file: { userSetting: "keep" }, token: "absent", runtimePresent: true });
    if (mode.startsWith("parent-")) expect(result.marker).toBe(true);
  }, 20_000);
}

test("recovery treats a foreground fixture as foreground even under a service-owned test runner", async () => {
  const result = await runRecovery("parent", false, { ...process.env, OCX_SERVICE: "1" });
  expect(result).toMatchObject({ role: "standalone", spawned: 1, recoveryAdmission: 202 });
}, 20_000);

test("a parent stop admitted before a recovery timer fires prevents the scheduled replacement", async () => {
  const result = await runRecovery("timer-parent-active");
  expect(result).toMatchObject({ role: "client", spawned: 0, state: "disconnected", phase: "complete", marker: true, runtimePresent: true });
}, 20_000);

test("a stale stop owner cannot block completed disconnect recovery", async () => {
  const result = await runRecovery("parent-stale-owner");
  expect(result).toMatchObject({ recoveryAdmission: 202, role: "standalone", spawned: 1, phase: "complete" });
}, 20_000);

test("a refused signal stop can reschedule a canceled recycle after disconnect recovery", async () => {
  const result = await runRecovery("signal-pending-recycle");
  expect(result).toMatchObject({ firstRecycleTimers: 1, firstRecycleCanceled: true, beforeRecoveryAdmission: 409, recoveryRecycleTimers: 1,
    role: "standalone", spawned: 1, file: { userSetting: "keep" }, state: "disconnected", phase: "complete", runtimePresent: false });
}, 20_000);

test("a parent stop remains fenced through an already-admitted restart rollback", async () => {
  const report = await runStop({ mode: "file-restart-overlap", preserve: "restart-rollback", fileClients: ["pi"] });
  expect(report.result).toEqual({ preflight: null, rolledBack: true, bound: true, stopping: true, explicitStop: true,
    sync: "client_runtime_stopping", admission: { kind: "stopping" } });
  expect(report.fileAfter.pi).not.toContain("127.0.0.1");
  expect(report.protectedUnchanged).toBe(true);
}, 20_000);

for (const failedRollback of ["before-rebind", "during-rebind"]) {
  for (const unverifiedStopOwner of [false, true]) test(`failed rollback (${failedRollback}) cannot recycle over an ${unverifiedStopOwner ? "unverified" : "active"} parent stop`, async () => {
    const report = await runStop({ mode: "file-restart-overlap", preserve: "restart-rollback", fileClients: ["pi"], failedRollback, unverifiedStopOwner });
    expect(report.result).toEqual({ preflight: null, replacementAttempts: 1, runtimePresent: true, explicitStop: true });
    expect(report.fileAfter.pi).not.toContain("127.0.0.1");
  }, 20_000);
}

test.skipIf(process.platform === "win32")("Link stop requires its recovery receipt before attempting any stop action", async () => {
  const report = await runStop({ mode: "file-stop", fileClients: ["pi"], receiptWriteFails: true });
  expect(report.result).toEqual({ exitCode: 1, calls: { service: 0, killed: 0 }, bound: true, stopping: true });
  expect(report.after).toBe(report.before);
  expect(report.protectedUnchanged).toBe(true);
}, 20_000);

test("parent preflight retries a busy config lock before fencing the exact runtime", async () => {
  const report = await runStop({ mode: "file-preflight", fileClients: ["pi"], busyStopFence: true });
  expect(report.result).toEqual({ outcome: null, bound: true, stopping: true });
  expect(report.fileAfter.pi).not.toContain("127.0.0.1");
}, 20_000);

test("restart rollback closes its unpublished listener in the binding turn when the config lock is busy", async () => {
  const report = await runStop({ mode: "file-restart-overlap", preserve: "restart-rollback", fileClients: ["pi"], busyRollbackPublication: true });
  expect(report.result).toEqual({ preflight: null, closedBeforeYield: true, published: false, replacementAttempts: 1 });
  expect(report.fileAfter.pi).not.toContain("127.0.0.1");
}, 20_000);

for (const retryRollbackPublication of ["lifecycle", "config", "owner-changed"] as const) {
  test("restart rollback rechecks its owner after " + retryRollbackPublication + " contention", async () => {
    const report = await runStop({ mode: "file-restart-overlap", preserve: "restart-rollback", fileClients: ["pi"], retryRollbackPublication });
    const resumed = retryRollbackPublication !== "owner-changed";
    expect(report.result).toEqual({ preflight: null, closedBeforeYield: true, published: resumed, bound: resumed,
      rollbackBinds: resumed ? 2 : 1, replacementAttempts: 1, stopping: true, explicitStop: true });
    expect(report.fileAfter.pi).not.toContain("127.0.0.1");
  }, 20_000);
}

test("ordinary restart rollback keeps file routes and admits fresh sync", async () => {
  const report = await runStop({ mode: "file-restart-control", preserve: "restart-rollback", fileClients: ["pi"] });
  expect(report.result).toEqual({ rolledBack: true, bound: true, stopping: false, explicitStop: false, sync: "accepted" });
  expect(report.fileAfter).toEqual(report.fileOwnedBytes);
  expect(report.protectedUnchanged).toBe(true);
}, 20_000);

test("a finished parent stop preserves the retained sync fence through restart rollback", async () => {
  const report = await runStop({ mode: "file-restart-overlap", preserve: "restart-rollback", fileClients: ["pi"], finishStopBeforeRollback: true });
  expect(report.result).toEqual({ preflight: null, rolledBack: true, bound: true, stopping: true, explicitStop: false, retainedStop: true,
    sync: "client_runtime_stopping", admission: { kind: "stopping" } });
  expect(report.fileAfter.pi).not.toContain("127.0.0.1");
}, 20_000);

test("a pending restart admission cannot leave routing behind on signal shutdown", async () => {
  const report = await runStop({ mode: "runtime", preserve: "restart" });
  expect(report.after).toBe('model = "native"\n');
  expect(report.journalRetained).toBe(false);
  expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
  expect(report.grokAfter).toBe('theme = "fixture"\n');
}, 20_000);

test.each(["restart-rollback", "restart-rollback-recycle"])("signal shutdown joins %s before restoring", async preserve => {
  const report = await runStop({ mode: "runtime", preserve });
  expect(report.after).toBe('model = "native"\n');
  expect(report.journalRetained).toBe(false);
  expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
  expect(report.grokAfter).toBe('theme = "fixture"\n');
}, 20_000);

test("a scheduled recycle cannot skip restoration or spawn after signal shutdown", async () => {
  const report = await runStop({ mode: "runtime", preserve: "recycle-pending" });
  expect(report.after).toBe('model = "native"\n');
  expect(report.journalRetained).toBe(false);
  expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
  expect(report.grokAfter).toBe('theme = "fixture"\n');
}, 20_000);
