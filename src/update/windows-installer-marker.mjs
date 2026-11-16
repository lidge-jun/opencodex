import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { probeProcessAlive } from "./mutation-guard.mjs";
import { assertNotRealHomeUnderTest } from "./test-home-guard.mjs";

// The Windows installer runs inside a private kill-on-close Job Object whose only handle lives in
// its PowerShell supervisor (npm-install-job.ps1). Once that supervisor process is gone, the job is
// closed and its tree terminated, so the supervisor pid is the Windows witness for an installer the
// launcher could not confirm, the counterpart of the POSIX process group (#8524).

function supervisorGone(pid) {
  try { probeProcessAlive(pid); return false; }
  catch (error) { return error?.code === "ESRCH"; }
}

/**
 * Record `pid` as the installer supervisor in the update marker before the supervisor receives its
 * request. The marker must be exactly in the state noteUntrackedInstaller writes: mutating,
 * termination unconfirmed, no POSIX group. An earlier supervisor pid may be replaced only once that
 * process is gone; a live or unprobeable one is kept and the publish refuses with EINSTALLWITNESS.
 */
export function publishWindowsInstallerPid(markerPath, pid, { gone = supervisorGone } = {}) {
  assertNotRealHomeUnderTest(dirname(markerPath));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("invalid installer supervisor pid");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  if (!marker || typeof marker !== "object" || marker.phase !== "mutating" || marker.terminationUnconfirmed !== true
    || !Number.isSafeInteger(marker.pid) || !Number.isSafeInteger(marker.startedAt) || marker.installerPgid !== undefined) {
    throw Error("update marker is not awaiting an installer");
  }
  if (marker.installerPid !== undefined && !(Number.isSafeInteger(marker.installerPid) && gone(marker.installerPid))) {
    throw Object.assign(Error("an earlier installer supervisor is still running"), { code: "EINSTALLWITNESS" });
  }
  const temp = `${markerPath}.${randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(temp, JSON.stringify({ ...marker, installerPid: pid }), { flag: "wx", mode: 0o600 });
    created = true;
    renameSync(temp, markerPath);
    created = false;
  } finally {
    if (created) try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
