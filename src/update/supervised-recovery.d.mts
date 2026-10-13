/** Declarations for the plain-ESM manager recovery shared with `bin/ocx.mjs` (#7043). */
export type ServiceManagerRun = (file: string, args: string[]) => { ok: boolean; stdout: string; stderr: string; timedOut?: boolean };
export interface ServiceManagerDeps {
  platform?: NodeJS.Platform;
  uid?: number;
  run?: ServiceManagerRun;
}
export type SupervisionVerdict =
  | { kind: "supervised"; managerPid: number; servingPid: number }
  | { kind: "failed"; reason: string };
export declare const LAUNCHD_SERVICE_LABEL: string;
export declare const SYSTEMD_SERVICE_UNIT: string;
export declare function parseLaunchdJobPid(printOutput: string): number | null;
export declare function parseSystemdMainPid(showOutput: string): number | null;
export declare function hasRestartableServiceManager(deps?: ServiceManagerDeps): boolean;
export declare function restartServiceManagerJob(deps?: ServiceManagerDeps):
  { ok: true } | { ok: false; reason: string; unsettled?: true };
export declare function freshServingPid(recordPid: number, staleRecordPid: number | null): number | null;
export declare function unsettledManagerWarning(port: number): string;
export declare function readServiceManagerPid(deps?: ServiceManagerDeps): number | null;
export declare function readParentPid(pid: number, deps?: ServiceManagerDeps): number | null;
export declare function supervisionVerdict(input: {
  servingPid: number | null;
  managerPid: number | null;
  parentPid: (pid: number) => number | null;
}): SupervisionVerdict;
export declare function unsupervisedRuntimeWarning(port: number): string;
