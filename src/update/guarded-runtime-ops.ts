import { isProcessAlive, waitForExit } from "../lib/process-control";
import type { killProxy } from "../lib/process-control";
import { atomicWriteFile } from "../config/atomic-write";
import { removePid, removeRuntimePort } from "../config/process-state";
import { dropWindowsTcpRowsForLocalPort } from "../server/windows-tcp-drop";
import { stopWinswService } from "../lib/winsw";
import { stopWindows } from "../service";
import { killWindowsSchedulerWrappers } from "../lib/windows-service-wrappers";
import { guardedRun, guardedKill, guardedExecFileSync, materializeMutationData, UpdateMutationRefusedError, type UpdateMutationAuthorizer } from "./mutation-guard.mjs";

export type KillProxy = typeof killProxy;
function mutationGate<K extends Parameters<UpdateMutationAuthorizer>[0]>(authorize: (kind: K) => boolean, kind: K) {
  return () => { if (authorize(kind) !== true) throw new UpdateMutationRefusedError(); };
}
export function guardedKillProxy<K extends "runtime" | "own-child">(authorize: (kind: K) => boolean, kind: K, pid: number, native?: KillProxy) {
  if (native) return guardedRun(authorize, kind, native, [pid]); // trusted external-I/O test seam
  const target = materializeMutationData(pid);
  if (!isProcessAlive(target)) return;
  if (process.platform === "win32") {
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    try { guardedExecFileSync(authorize, kind, taskkill, ["/PID", String(target), "/T", "/F"], { stdio: "pipe", windowsHide: true }); }
    catch (error) { if (error instanceof UpdateMutationRefusedError || isProcessAlive(target)) throw error; }
  } else {
    guardedKill(authorize, kind, target, "SIGTERM");
    if (!waitForExit(target, 5000)) guardedKill(authorize, kind, target, "SIGKILL");
  }
  if (!waitForExit(target, 5000)) throw new Error(`process ${target} did not exit`);
}
export function guardedPublishJob(authorize: UpdateMutationAuthorizer, kind: "publish" | "package-publish",
  target: string, text: string, native: typeof atomicWriteFile = atomicWriteFile): void {
  const [path, payload] = materializeMutationData([target, text]);
  const validateBeforeRename = () => { if (authorize(kind) !== true) throw new UpdateMutationRefusedError(); };
  validateBeforeRename();
  // The atomic writer carries this gate through temp preparation AND every rename retry.
  native(path, payload, undefined, { validateBeforeRename });
}
export function guardedRemovePid(authorize: (kind: "runtime") => boolean, pid?: number) {
  return removePid(materializeMutationData(pid), mutationGate(authorize, "runtime"));
}
export function guardedRemoveRuntimePort(authorize: (kind: "runtime") => boolean) {
  return removeRuntimePort(undefined, mutationGate(authorize, "runtime"));
}
export function guardedDropWindowsTcp(authorize: (kind: "runtime") => boolean, port: number) {
  const target = materializeMutationData(port);
  return dropWindowsTcpRowsForLocalPort(target, () => {
    if (authorize("runtime") !== true) throw new UpdateMutationRefusedError();
    return true;
  });
}
export function guardedStopWinsw(authorize: UpdateMutationAuthorizer) {
  return stopWinswService(mutationGate(authorize, "service"));
}
export function guardedStopWindows(authorize: UpdateMutationAuthorizer) {
  return stopWindows(mutationGate(authorize, "service"));
}
export function guardedKillWindowsWrappers(authorize: UpdateMutationAuthorizer, paths: Parameters<typeof killWindowsSchedulerWrappers>[0]) {
  return killWindowsSchedulerWrappers(materializeMutationData(paths), mutationGate(authorize, "service"));
}
