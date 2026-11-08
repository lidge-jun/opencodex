import { spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { types } from "node:util";
import * as lockFile from "../../src/codex/native-main-lock-file";

type Injection = "open" | "hardening" | "sqlite" | "stall";

export function skipInvalidQuotaTag(platform: string, githubActions: string | undefined, diagnostic: string | undefined): boolean {
  return platform === "win32" && githubActions === "true" && diagnostic !== "1";
}

/** Accept only the observer's bounded fields, never arbitrary child output. */
export function formatClaimDiagnostics(records: string): string {
  const prefix = '{"fixture":"claim-diagnostics",';
  const line = records.split("\n").filter(row => row.startsWith(prefix)).findLast(row => {
    try { JSON.parse(row); return true; } catch { return false; }
  });
  if (!line) return "claim diagnostics unavailable";
  try {
    const { diagnostics } = JSON.parse(line);
    const phases = ["not-started", "open", "hardening", "sqlite-open", "sqlite-pragma", "sqlite-journal-mode",
      "identity-after-hardening", "identity-after-sqlite-setup", "identity-after-transaction", "identity-unknown",
      "transaction", "transaction-read", "operation"];
    const codes = ["EACCES", "EPERM", "ENOENT", "EBUSY", "ETIMEDOUT", "EICACLS", "EACLIDENTITY",
      "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CANTOPEN", "SQLITE_NOTADB"];
    const steps = ["/grant:r", "/inheritance:r", "/remove:g", "/findsid"];
    const stages = ["deadline_before_spawn", "spawn_failed", "runner_rejected", "runner_watchdog", "child_result"];
    const failure = diagnostics?.failure;
    const safeFailure = failure && typeof failure === "object" ? {
      ...(phases.includes(failure.phase) ? { phase: failure.phase } : {}),
      ...(codes.includes(failure.code) ? { code: failure.code } : {}),
      ...(steps.includes(failure.step) ? { step: failure.step } : {}),
      ...(stages.includes(failure.stage) ? { stage: failure.stage } : {}),
      ...(typeof failure.timedOut === "boolean" ? { timedOut: failure.timedOut } : {}),
    } : undefined;
    return JSON.stringify({ ...(phases.includes(diagnostics?.phase) ? { phase: diagnostics.phase } : {}),
      ...(safeFailure ? { failure: safeFailure } : {}) });
  } catch { return "claim diagnostics unavailable"; }
}

/** Observe the real claim setup without publishing paths, messages, or subprocess output. */
export function observeNativeMainClaim(inject?: Injection, testError?: Error, diagnosticsPath?: string) {
  let phase = "not-started";
  const events: string[] = [];
  let insideOpen = false;
  let failure: Record<string, unknown> | undefined;
  // Synchronous append makes each bounded snapshot available before a forced child termination.
  function publish(): void {
    if (diagnosticsPath) appendFileSync(diagnosticsPath, JSON.stringify({ fixture: "claim-diagnostics", diagnostics: { phase, failure } }) + "\n");
  }
  function setPhase(next: string): void { phase = next; events.push(next); publish(); }
  publish();
  const ownDescriptor = Object.getOwnPropertyDescriptor;
  const hasOwn = Object.hasOwn;
  const isProxy = types.isProxy;
  function dataProperty(value: unknown, key: string): unknown {
    if ((typeof value !== "object" && typeof value !== "function") || value === null || isProxy(value)) return undefined;
    const descriptor = ownDescriptor(value, key);
    return descriptor && hasOwn(descriptor, "value") ? descriptor.value : undefined;
  }
  function record(error: unknown): void {
    try {
      const rawCode = dataProperty(error, "code");
      const code = rawCode === "EACCES" || rawCode === "EPERM" || rawCode === "ENOENT" || rawCode === "EBUSY"
        || rawCode === "ETIMEDOUT" || rawCode === "EICACLS" || rawCode === "EACLIDENTITY"
        || rawCode === "SQLITE_BUSY" || rawCode === "SQLITE_LOCKED" || rawCode === "SQLITE_CANTOPEN" || rawCode === "SQLITE_NOTADB" ? rawCode : undefined;
      const acl = dataProperty(error, "aclFailure");
      const rawStep = dataProperty(acl, "step");
      const rawStage = dataProperty(acl, "stage");
      const timedOut = dataProperty(acl, "timedOut");
      const step = rawStep === "/grant:r" || rawStep === "/inheritance:r" || rawStep === "/remove:g" || rawStep === "/findsid" ? rawStep : undefined;
      const stage = rawStage === "deadline_before_spawn" || rawStage === "spawn_failed" || rawStage === "runner_rejected"
        || rawStage === "runner_watchdog" || rawStage === "child_result" ? rawStage : undefined;
      failure = { phase, ...(code ? { code } : {}), ...(step ? { step } : {}),
        ...(stage ? { stage } : {}), ...(typeof timedOut === "boolean" ? { timedOut } : {}) };
    } catch { failure = { phase }; }
    publish();
  }
  const injectedError = testError ?? Object.assign(new Error("private-marker-path-token-message"), { code: "EICACLS", aclFailure: {
      step: "/inheritance:r", stage: "child_result", timedOut: false, stdout: "private-marker-stdout",
    } });
  const open = lockFile.openStableLockFile;
  const harden = lockFile.hardenStableLockFile;
  const assertStable = lockFile.assertStableLockFile;
  const exec = Database.prototype.exec;
  const query = Database.prototype.query;
  const statementSpies: { mockRestore(): void }[] = [];
  const openSpy = spyOn(lockFile, "openStableLockFile").mockImplementation((...args) => {
    setPhase("open");
    insideOpen = true;
    try { if (inject === "open") throw injectedError; const result = open(...args); setPhase("sqlite-open"); return result; }
    catch (error) { record(error); throw error; }
    finally { insideOpen = false; }
  });
  const hardenSpy = spyOn(lockFile, "hardenStableLockFile").mockImplementation(async (...args) => {
    setPhase("hardening");
    if (inject === "stall") {
      console.error("private-marker-child-stderr /private-claim-path fixture-secret-token");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
    }
    try { if (inject === "hardening") throw injectedError; await harden(...args); }
    catch (error) { record(error); throw error; }
  });
  const assertSpy = spyOn(lockFile, "assertStableLockFile").mockImplementation((...args) => {
    if (insideOpen) return assertStable(...args);
    const check = phase === "hardening" ? "identity-after-hardening"
      : phase === "sqlite-journal-mode" ? "identity-after-sqlite-setup"
      : phase === "transaction" || phase === "transaction-read" ? "identity-after-transaction" : "identity-unknown";
    setPhase(check);
    try { assertStable(...args); setPhase(check === "identity-after-hardening" ? "sqlite-open" : check === "identity-after-sqlite-setup" ? "transaction" : "operation"); }
    catch (error) { record(error); throw error; }
  });
  const execSpy = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string, ...args: any[]) {
    if (sql === "PRAGMA busy_timeout = 0; PRAGMA locking_mode = NORMAL") setPhase("sqlite-pragma");
    else if (sql === "BEGIN EXCLUSIVE" || sql === "BEGIN") setPhase("transaction");
    else return exec.call(this, sql, ...args);
    try { if (inject === "sqlite" && phase === "sqlite-pragma") throw injectedError; return exec.call(this, sql, ...args); }
    catch (error) { record(error); throw error; }
  } as typeof Database.prototype.exec);
  const querySpy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
    if (sql === "PRAGMA journal_mode = DELETE") setPhase("sqlite-journal-mode");
    else if (sql === "SELECT rootpage FROM sqlite_schema LIMIT 1") setPhase("transaction-read");
    else return query.call(this, sql);
    let statement: ReturnType<typeof query>;
    try { statement = query.call(this, sql); } catch (error) { record(error); throw error; }
    try {
      const get = statement.get;
      const spy = spyOn(statement, "get").mockImplementation(function (this: typeof statement, ...args: any[]) {
        try { return get.apply(this, args); } catch (error) { record(error); throw error; }
      } as typeof statement.get);
      statementSpies.push(spy);
    } catch { /* An uninstrumentable statement still executes unchanged. */ }
    return statement;
  } as typeof Database.prototype.query);
  return {
    injectedError,
    events: () => [...events],
    snapshot: () => ({ phase, failure }),
    restore: () => { for (const spy of statementSpies) spy.mockRestore(); querySpy.mockRestore(); execSpy.mockRestore(); assertSpy.mockRestore(); hardenSpy.mockRestore(); openSpy.mockRestore(); },
  };
}
