import { guardedRun, UpdateMutationRefusedError } from "../../src/update/mutation-guard.mjs";

/** Run the real materialization/authorization boundary with external primitive I/O
 * injected by source-body tests. An absent seam throws; it never reaches the host. */
export function guardedUpdateIo(deps) {
  const native = name => deps[name] ?? (() => { throw new Error(`Missing update I/O seam: ${name}`); });
  return {
    prepareUpdateJob: (job, patch, line) => ({ ...job, ...patch, log: line ? [...(job.log ?? []), line] : job.log }),
    writeJob: (job, auth, kind = "publish") => job.status === "succeeded"
      ? guardedRun(auth ?? (() => false), kind, deps.writeJob ?? (job => native("updateJob")(job, job)), [job])
      : (deps.writeJob ?? (job => native("updateJob")(job, job)))(job),
    probeSpawn: native("spawn"), probeSpawnSync: native("spawnSync"),
    probeProcessAlive: pid => deps.process.kill(pid, 0),
    relayOwnSignal: signal => deps.process.kill(deps.process.pid, signal),
    guardedRun,
    guardedPublishJob: (auth, kind, target, text) => guardedRun(auth, kind, native("atomicWriteFile"), [target, text]),
    UpdateMutationRefusedError,
    guardedExit: (auth, kind, code) => guardedRun(auth, kind, deps.process.exit.bind(deps.process), [code]),
    guardedSpawn: (auth, kind, ...args) => guardedRun(auth, kind, native("spawn"), args),
    guardedSpawnSync: (auth, kind, ...args) => guardedRun(auth, kind, native("spawnSync"), args),
    guardedKillProxy: (auth, kind, pid, override) => guardedRun(auth, kind, override ?? native("killProxy"), [pid]),
    guardedRemovePid: (auth, ...args) => guardedRun(auth, "runtime", native("removePid"), args),
    guardedRemoveRuntimePort: auth => guardedRun(auth, "runtime", native("removeRuntimePort"), []),
    guardedDropWindowsTcp: (auth, ...args) => guardedRun(auth, "runtime", native("dropWindowsTcpRowsForLocalPort"), args),
    guardedStopWinsw: auth => guardedRun(auth, "service", native("stopWinswService"), []),
    guardedStopWindows: auth => guardedRun(auth, "service", native("stopWindows"), []),
    guardedKillWindowsWrappers: (auth, ...args) => guardedRun(auth, "service", native("killWindowsSchedulerWrappers"), args),
  };
}

export function guardedTrayIo(tray) {
  return { ...tray,
    guardedStopWindowsTray: auth => guardedRun(auth, "tray", tray.stopWindowsTray, []),
    guardedStartWindowsTray: auth => guardedRun(auth, "own-tray", tray.startWindowsTray, []),
  };
}
