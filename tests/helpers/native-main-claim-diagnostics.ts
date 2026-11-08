import { spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { types } from "node:util";
import * as lockFile from "../../src/codex/native-main-lock-file";

type Injection = "open" | "hardening" | "sqlite";

/** Observe the real claim setup without publishing paths, messages, or subprocess output. */
export function observeNativeMainClaim(inject?: Injection, testError?: Error) {
  let phase = "not-started";
  const events: string[] = [];
  function setPhase(next: string): void { phase = next; events.push(next); }
  let insideOpen = false;
  let failure: Record<string, unknown> | undefined;
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
