import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  failedHistoryRestoreFromOutcome,
  formatApplyHistoryFailure,
} from "../src/codex/inject";

const injectSource = readFileSync(resolve(import.meta.dir, "../src/codex/inject.ts"), "utf8");
const doctorSource = readFileSync(resolve(import.meta.dir, "../src/cli/doctor.ts"), "utf8");
const cliSource = readFileSync(resolve(import.meta.dir, "../src/cli/index.ts"), "utf8");
const integrationGuide = readFileSync(
  resolve(import.meta.dir, "../docs-site/src/content/docs/guides/codex-integration.md"),
  "utf8",
);

test("apply keeps the deferred headline for busy outcomes from either half", () => {
  const blockedBusy = { kind: "blocked", reason: "busy" } as const;
  expect(formatApplyHistoryFailure(blockedBusy, false)).toContain("metadata restore deferred");
  expect(formatApplyHistoryFailure(blockedBusy, false)).toContain("history DB is locked");

  const workerBusy = {
    kind: "failed",
    reason: "worker-error",
    message: "database is locked",
    historyFailureReason: "busy",
  } as const;
  expect(formatApplyHistoryFailure(workerBusy, false)).toContain("metadata restore deferred");
  expect(formatApplyHistoryFailure(workerBusy, false)).toContain("retried automatically");
});

test("apply says NOT changed for non-busy failures", () => {
  const unsafe = { kind: "blocked", reason: "unsafe-path" } as const;
  expect(formatApplyHistoryFailure(unsafe, false)).toContain("NOT changed");
  expect(formatApplyHistoryFailure(unsafe, false)).toContain("not a Codex app lock");

  const workerError = { kind: "failed", reason: "worker-error", message: "unable to open database file" } as const;
  expect(formatApplyHistoryFailure(workerError, false)).toContain("NOT changed");
  expect(formatApplyHistoryFailure(workerError, false)).toContain("unable to open database file");

  const partial = {
    kind: "failed", reason: "worker-error", message: "history_transition_failed",
    historyFailureReason: "integrity", rows: 1, files: 1,
  } as const;
  expect(formatApplyHistoryFailure(partial, false)).toContain("changed but did not converge");
  expect(formatApplyHistoryFailure(partial, false)).not.toContain("NOT changed");
  expect(formatApplyHistoryFailure(partial, true)).toContain("changed but did not converge");
  expect(formatApplyHistoryFailure(partial, true)).not.toContain("sync SKIPPED");
});

test("restore blames the Codex app only for genuine busy reasons", () => {
  const blockedBusy = { kind: "blocked", reason: "busy" } as const;
  expect(failedHistoryRestoreFromOutcome(blockedBusy).message).toContain("holding the history database");

  const workerBusy = {
    kind: "failed",
    reason: "worker-error",
    message: "database is locked",
    historyFailureReason: "busy",
  } as const;
  expect(failedHistoryRestoreFromOutcome(workerBusy).message).toContain("history state is busy");
  expect(failedHistoryRestoreFromOutcome(workerBusy).message).not.toContain("holding the history database");
  const partialBusy = failedHistoryRestoreFromOutcome({ ...workerBusy, rows: 1, files: 1 });
  expect(partialBusy.changed).toBe(true);
  expect(partialBusy.rows).toBe(1);
  expect(partialBusy.files).toBe(1);
  expect(partialBusy.message).toContain("finalization remained busy");
  expect(partialBusy.message).toContain("manifest was retained");
});

test("restore names other reasons instead of a lock", () => {
  const unsafe = { kind: "blocked", reason: "unsafe-path" } as const;
  const unsafeMessage = failedHistoryRestoreFromOutcome(unsafe).message;
  expect(unsafeMessage).toContain("unsafe coordinator namespace");
  expect(unsafeMessage).not.toContain("holding the history database");

  const permission = {
    kind: "failed",
    reason: "worker-error",
    message: "history_transition_failed",
    historyFailureReason: "permission",
  } as const;
  expect(failedHistoryRestoreFromOutcome(permission).message).toContain("permission was denied");
  const partialPermission = failedHistoryRestoreFromOutcome({ ...permission, rows: 1, files: 1 });
  expect(partialPermission.changed).toBe(true);
  expect(partialPermission.rows).toBe(1);
  expect(partialPermission.files).toBe(1);
  expect(partialPermission.message).toContain("permission was denied");
  expect(partialPermission.message).toContain("manifest was retained");

  const workerError = { kind: "failed", reason: "worker-error", message: "unable to open database file" } as const;
  const workerMessage = failedHistoryRestoreFromOutcome(workerError).message;
  expect(workerMessage).toContain("unable to open database file");
  expect(workerMessage).not.toContain("holding the history database");

  const integrity = {
    kind: "failed",
    reason: "worker-error",
    message: "history_transition_failed",
    historyFailureReason: "integrity",
  } as const;
  const integrityResult = failedHistoryRestoreFromOutcome(integrity);
  expect(integrityResult.reason).toBe("integrity");
  expect(integrityResult.message).toContain("failed integrity checks");
  expect(integrityResult.message).not.toContain("holding the history database");

  const partialIntegrity = failedHistoryRestoreFromOutcome({ ...integrity, rows: 1, files: 1 });
  expect(partialIntegrity.changed).toBe(true);
  expect(partialIntegrity.rows).toBe(1);
  expect(partialIntegrity.files).toBe(1);
  expect(partialIntegrity.message).toContain("changed but did NOT converge");
  expect(partialIntegrity.message).toContain("manifest was retained");
});

test("success and no-op surfaces describe exact manifest restoration without provider assumptions", () => {
  expect(injectSource).toContain("changed: rawHistory.rows > 0 || rawHistory.files > 0");
  expect(injectSource).toContain("restored original provider metadata for ${migratedRows} manifest-backed thread(s)");
  expect(injectSource).toContain("original providers preserved");
  expect(injectSource).toContain("No backed-up resume-history metadata was pending; untracked routed history was left unchanged.");
  expect(injectSource).not.toContain("migrated back to openai");
  expect(injectSource).not.toContain("Codex resume history was already native");
});

test("doctor distinguishes zero, pending, retryable, and integrity restore states", () => {
  expect(doctorSource).toContain("no manifest-backed provider metadata pending; untracked routed history is unchanged");
  expect(doctorSource).toContain("backup manifest entr${pending.backupEntries === 1 ? \"y\" : \"ies\"} pending exact metadata restore");
  expect(doctorSource).toContain("history database, backup manifest, or rollout file is busy — exact metadata restore is pending");
  expect(doctorSource).toContain("backup manifest or restore target failed integrity checks — manual review required");
  expect(doctorSource).toContain("do not repeatedly run 'ocx sync' until the mismatch is understood");
  expect(doctorSource).toContain("Untracked routed history is not relabeled.");
  expect(doctorSource).not.toContain("no legacy opencodex-tagged threads pending");
});

test("legacy recovery surfaces its full destructive scope before execution", () => {
  expect(cliSource).toContain("every user-message opencodex row");
  expect(integrationGuide).toContain("every thread");
  expect(integrationGuide).toContain("currently tagged `opencodex`");
  expect(cliSource).toContain("dedicated-provider history");
  expect(integrationGuide).toContain("dedicated-provider history");
  expect(cliSource).toContain("normalizes exec to cli");
  expect(integrationGuide).toContain("normalizes `exec` to `cli`");
});
