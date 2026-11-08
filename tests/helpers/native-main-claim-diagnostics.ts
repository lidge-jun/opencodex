import { spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as lockFile from "../../src/codex/native-main-lock-file";

type Injection = "open" | "hardening" | "sqlite";

/** Observe the real claim setup without publishing paths, messages, or subprocess output. */
export function observeNativeMainClaim(inject?: Injection, testError?: Error) {
  let phase = "not-started";
  let completedChecks = 0;
  let failure: Record<string, unknown> | undefined;
  const codes = new Set(["EACCES", "EPERM", "ENOENT", "EBUSY", "ETIMEDOUT", "EICACLS", "EACLIDENTITY", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CANTOPEN", "SQLITE_NOTADB"]);
  const steps = new Set(["/grant:r", "/inheritance:r", "/remove:g", "/findsid"]);
  const stages = new Set(["deadline_before_spawn", "spawn_failed", "runner_rejected", "runner_watchdog", "child_result"]);
  function record(error: unknown): void {
    try {
      const value = error as { code?: unknown; aclFailure?: { step?: unknown; stage?: unknown; timedOut?: unknown } };
      const rawCode = value?.code;
      const code = typeof rawCode === "string" && codes.has(rawCode) ? rawCode : undefined;
      const acl = value?.aclFailure;
      const rawStep = acl?.step;
      const rawStage = acl?.stage;
      const timedOut = acl?.timedOut;
      const step = typeof rawStep === "string" && steps.has(rawStep) ? rawStep : undefined;
      const stage = typeof rawStage === "string" && stages.has(rawStage) ? rawStage : undefined;
      failure = { phase, ...(code ? { code } : {}), ...(step ? { step } : {}),
        ...(stage ? { stage } : {}), ...(typeof timedOut === "boolean" ? { timedOut } : {}) };
    } catch { failure = { phase }; }
  }
  const injectedError = testError ?? Object.assign(new Error("private-marker-path-token-message"), { code: "EICACLS", aclFailure: {
      step: "/inheritance:r", stage: "child_result", timedOut: false, stdout: "private-marker-stdout",
    } });
  const open = lockFile.openStableLockFile;
  const harden = lockFile.hardenStableLockFile;
  const assertStable = lockFile.assertStableLockFile;
  const exec = Database.prototype.exec;
  const query = Database.prototype.query;
  const openSpy = spyOn(lockFile, "openStableLockFile").mockImplementation((...args) => {
    phase = "open";
    completedChecks = 0;
    try { if (inject === "open") throw injectedError; return open(...args); }
    catch (error) { record(error); throw error; }
  });
  const hardenSpy = spyOn(lockFile, "hardenStableLockFile").mockImplementation(async (...args) => {
    phase = "hardening";
    try { if (inject === "hardening") throw injectedError; await harden(...args); }
    catch (error) { record(error); throw error; }
  });
  const assertSpy = spyOn(lockFile, "assertStableLockFile").mockImplementation((...args) => {
    phase = completedChecks === 0 ? "identity-after-hardening" : completedChecks === 1 ? "identity-after-sqlite-setup" : "identity-after-transaction";
    try { assertStable(...args); completedChecks++; phase = completedChecks === 1 ? "sqlite-open" : completedChecks === 2 ? "transaction" : "operation"; }
    catch (error) { record(error); throw error; }
  });
  const execSpy = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string, ...args: any[]) {
    if (sql === "PRAGMA busy_timeout = 0; PRAGMA locking_mode = NORMAL") phase = "sqlite-pragma";
    else if (sql === "BEGIN EXCLUSIVE" || sql === "BEGIN") phase = "transaction";
    else return exec.call(this, sql, ...args);
    try { if (inject === "sqlite" && phase === "sqlite-pragma") throw injectedError; return exec.call(this, sql, ...args); }
    catch (error) { record(error); throw error; }
  } as typeof Database.prototype.exec);
  const querySpy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
    if (sql === "PRAGMA journal_mode = DELETE") phase = "sqlite-journal-mode";
    else if (sql === "SELECT rootpage FROM sqlite_schema LIMIT 1") phase = "transaction-read";
    else return query.call(this, sql);
    try { return query.call(this, sql); } catch (error) { record(error); throw error; }
  } as typeof Database.prototype.query);
  return {
    injectedError,
    snapshot: () => ({ phase, failure }),
    restore: () => { querySpy.mockRestore(); execSpy.mockRestore(); assertSpy.mockRestore(); hardenSpy.mockRestore(); openSpy.mockRestore(); },
  };
}
