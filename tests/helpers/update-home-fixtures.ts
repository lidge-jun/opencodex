import type { RestartIo } from "../../src/update/job";

/** Non-home restart tests explicitly own their fake service and never touch a live manager. */
export const sameHomeRestartIo: Pick<RestartIo, "serviceHomeAuthorityFn" | "stopServiceWrappersFn" | "restartServiceManagerFn"> = {
  serviceHomeAuthorityFn: () => ({ kind: "same" }),
  stopServiceWrappersFn: () => {},
  // These fixtures exercise direct fallback, not host-dependent launchd/systemd probes.
  // Preserve the real manager boundary's lease release before the fallback reacquires it.
  restartServiceManagerFn: async target => { target.release?.(); return "failed"; },
};
export const absentHomeRestartIo: typeof sameHomeRestartIo = {
  ...sameHomeRestartIo,
  serviceHomeAuthorityFn: () => ({ kind: "absent" }),
};
