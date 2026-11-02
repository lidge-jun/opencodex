import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { inspectUpdateMarker, tryAcquireUpdateSyncMutex } from "./sync-update-mutex.mjs";
import { assertNotRealHomeUnderTest } from "./test-home-guard.mjs";

function atomicJson(path, value) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
    renameSync(temp, path);
    created = false;
  } finally {
    if (created) { try { unlinkSync(temp); } catch { /* preserve the original write error */ } }
  }
}

function validateExpect(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "cliRoot,home,planToken,runtimePid,servingRoot"
    || typeof value.home !== "string" || !isAbsolute(value.home)
    || typeof value.cliRoot !== "string" || !isAbsolute(value.cliRoot)
    || (value.servingRoot !== null && (typeof value.servingRoot !== "string" || !isAbsolute(value.servingRoot)))
    || (value.runtimePid !== null && (!Number.isSafeInteger(value.runtimePid) || value.runtimePid <= 0))
    || typeof value.planToken !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value.planToken)) {
    throw new Error("invalid orchestrated expectation");
  }
  return value;
}
export function encodeOrchestratedExpect(value) {
  return Buffer.from(JSON.stringify(validateExpect(value)), "utf8").toString("base64url");
}
export function decodeOrchestratedExpect(encoded) {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid orchestrated expectation");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) throw new Error("invalid orchestrated expectation");
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("invalid orchestrated expectation"); }
  return validateExpect(parsed);
}

export function createOrchestratedChildSession({ home, resultPath, expect, notAfter, now = Date.now, pid = process.pid, verifyIdentity }) {
  if (expect !== undefined) validateExpect(expect);
  if ((expect !== undefined && expect.home !== home) || (resultPath !== undefined && (typeof resultPath !== "string" || !isAbsolute(resultPath)))
    || (notAfter !== undefined && (!Number.isSafeInteger(notAfter) || notAfter <= 0))
    || !Number.isSafeInteger(pid) || pid <= 0 || typeof now !== "function" || typeof verifyIdentity !== "function") {
    throw new Error("invalid orchestrated session options");
  }
  assertNotRealHomeUnderTest(home);
  const markerPath = join(home, "update-orchestrated.json");
  const result = value => { if (resultPath !== undefined) atomicJson(resultPath, value); };
  let state = "new", mutex, startedAt, untrackedPending = false;
  const marker = (phase, preserveInstaller = false, terminationUnconfirmed = false) => {
    let installer = {};
    if (preserveInstaller) {
      const current = JSON.parse(readFileSync(markerPath, "utf8"));
      if (current.pid !== pid || current.startedAt !== startedAt) throw new Error("orchestrated marker changed");
      if (current.installerPid !== undefined) installer.installerPid = current.installerPid;
      if (current.installerPgid !== undefined) installer.installerPgid = current.installerPgid;
    }
    atomicJson(markerPath, { pid, phase, startedAt, ...installer, ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}) });
  };
  return {
    start() {
      if (state !== "new") throw new Error("orchestrated session already started");
      result({ phase: "preflight" });
      const acquired = tryAcquireUpdateSyncMutex(home, "update");
      if (acquired.kind === "busy") {
        const error = acquired.holder === "sync" ? "sync-in-progress" : "update-in-flight";
        result({ phase: "refused", error }); state = "refused";
        return { ok: false, error };
      }
      mutex = acquired;
      if (inspectUpdateMarker(home) !== "free") {
        mutex.release(); mutex = undefined;
        result({ phase: "refused", error: "update-in-flight" }); state = "refused";
        return { ok: false, error: "update-in-flight" };
      }
      try { startedAt = now(); marker("preflight"); }
      catch (error) { mutex.release(); mutex = undefined; throw error; }
      state = "preflight";
      return { ok: true };
    },
    finishPreflight() {
      if (state !== "preflight") return;
      marker("failed");
      mutex.release(); mutex = undefined; state = "finished";
    },
    async enterMutation() {
      if (state !== "preflight") throw new Error("orchestrated session is not in preflight");
      state = "entering";
      marker("mutating");
      result({ phase: "mutating" });
      let error;
      if (notAfter !== undefined && now() > notAfter) error = "deadline-passed";
      else {
        try { if (await verifyIdentity() !== true) error = "plan-changed"; }
        catch { error = "plan-changed"; }
      }
      if (!error && notAfter !== undefined && now() > notAfter) error = "deadline-passed";
      if (error) {
        marker("refused");
        result({ phase: "refused", error });
        mutex.release(); mutex = undefined; state = "refused";
        return { ok: false, error };
      }
      state = "mutating";
      return { ok: true };
    },
    noteUntrackedInstaller() {
      if (state !== "mutating") throw new Error("orchestrated session is not mutating");
      marker("mutating", true, true); untrackedPending = true;
    },
    confirmInstallerExit() {
      if (state !== "mutating" || !untrackedPending) throw new Error("no untracked installer");
      marker("mutating", true); untrackedPending = false;
    },
    finish(outcome) {
      if (state !== "mutating") throw new Error("orchestrated session is not mutating");
      if (!outcome || (outcome.phase !== "installed" && outcome.phase !== "failed")) throw new Error("invalid final outcome");
      if (untrackedPending) outcome = { phase: "failed", error: "installer-termination-unconfirmed" };
      result(outcome);
      marker(outcome.phase, true, outcome.error === "installer-termination-unconfirmed");
      mutex.release(); mutex = undefined; state = "finished";
    },
  };
}

export function createLegacyUpdateSession({ home }) {
  return createOrchestratedChildSession({ home, verifyIdentity: () => true });
}
