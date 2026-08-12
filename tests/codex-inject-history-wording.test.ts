import { expect, test } from "bun:test";

import {
  failedHistoryRestoreFromOutcome,
  formatApplyHistoryFailure,
} from "../src/codex/inject";

test("apply keeps the deferred headline for busy outcomes from either half", () => {
  const blockedBusy = { kind: "blocked", reason: "busy" } as const;
  expect(formatApplyHistoryFailure(blockedBusy, false)).toContain("migration deferred");
  expect(formatApplyHistoryFailure(blockedBusy, false)).toContain("history DB is locked");

  const workerBusy = {
    kind: "failed",
    reason: "worker-error",
    message: "database is locked",
    historyFailureReason: "busy",
  } as const;
  expect(formatApplyHistoryFailure(workerBusy, false)).toContain("migration deferred");
  expect(formatApplyHistoryFailure(workerBusy, false)).toContain("retried automatically");
});

test("apply says NOT changed for non-busy failures", () => {
  const unsafe = { kind: "blocked", reason: "unsafe-path" } as const;
  expect(formatApplyHistoryFailure(unsafe, false)).toContain("NOT changed");
  expect(formatApplyHistoryFailure(unsafe, false)).toContain("not a Codex app lock");

  const workerError = { kind: "failed", reason: "worker-error", message: "unable to open database file" } as const;
  expect(formatApplyHistoryFailure(workerError, false)).toContain("NOT changed");
  expect(formatApplyHistoryFailure(workerError, false)).toContain("unable to open database file");
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
  expect(failedHistoryRestoreFromOutcome(workerBusy).message).toContain("holding the history database");
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

  const workerError = { kind: "failed", reason: "worker-error", message: "unable to open database file" } as const;
  const workerMessage = failedHistoryRestoreFromOutcome(workerError).message;
  expect(workerMessage).toContain("unable to open database file");
  expect(workerMessage).not.toContain("holding the history database");
});
