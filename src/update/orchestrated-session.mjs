import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { tryAcquireUpdateSyncMutex } from "./sync-update-mutex.mjs";
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
  validateExpect(expect);
  if (expect.home !== home || typeof resultPath !== "string" || !isAbsolute(resultPath)
    || (notAfter !== undefined && (!Number.isSafeInteger(notAfter) || notAfter <= 0))
    || !Number.isSafeInteger(pid) || pid <= 0 || typeof now !== "function" || typeof verifyIdentity !== "function") {
    throw new Error("invalid orchestrated session options");
  }
  assertNotRealHomeUnderTest(home);
  const markerPath = join(home, "update-orchestrated.json");
  let state = "new", mutex, startedAt;
  const marker = phase => atomicJson(markerPath, { pid, phase, startedAt });
  return {
    start() {
      if (state !== "new") throw new Error("orchestrated session already started");
      atomicJson(resultPath, { phase: "preflight" });
      const acquired = tryAcquireUpdateSyncMutex(home, "update");
      if (acquired.kind === "busy") {
        const error = acquired.holder === "sync" ? "sync-in-progress" : "update-in-flight";
        atomicJson(resultPath, { phase: "refused", error }); state = "refused";
        return { ok: false, error };
      }
      mutex = acquired;
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
      atomicJson(resultPath, { phase: "mutating" });
      let error;
      if (notAfter !== undefined && now() > notAfter) error = "deadline-passed";
      else {
        try { if (await verifyIdentity() !== true) error = "plan-changed"; }
        catch { error = "plan-changed"; }
      }
      if (!error && notAfter !== undefined && now() > notAfter) error = "deadline-passed";
      if (error) {
        marker("refused");
        atomicJson(resultPath, { phase: "refused", error });
        mutex.release(); mutex = undefined; state = "refused";
        return { ok: false, error };
      }
      state = "mutating";
      return { ok: true };
    },
    finish(outcome) {
      if (state !== "mutating") throw new Error("orchestrated session is not mutating");
      if (!outcome || (outcome.phase !== "installed" && outcome.phase !== "failed")) throw new Error("invalid final outcome");
      atomicJson(resultPath, outcome);
      marker(outcome.phase);
      mutex.release(); mutex = undefined; state = "finished";
    },
  };
}
