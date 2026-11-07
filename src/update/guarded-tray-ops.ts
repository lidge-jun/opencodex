import { getWindowsTrayStatus, startWindowsTray, stopWindowsTray } from "../tray/windows";
import { guardedRun, UpdateMutationRefusedError, type UpdateMutationAuthorizer } from "./mutation-guard.mjs";
export { getWindowsTrayStatus };
export function guardedStartWindowsTray(authorize: UpdateMutationAuthorizer) {
  return guardedRun(authorize, "own-tray", startWindowsTray, []);
}
export function guardedStopWindowsTray(authorize: UpdateMutationAuthorizer) {
  return stopWindowsTray(() => { if (authorize("tray") !== true) throw new UpdateMutationRefusedError(); });
}
