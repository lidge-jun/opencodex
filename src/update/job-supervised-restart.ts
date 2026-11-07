import { readRuntimePort } from "../config/process-state";
import { proxyIdentityAt } from "../server/proxy-liveness";
import { createUpdateServiceHomePolicy, inspectUpdateServiceHome, updateServiceHomeRefusal, type UpdateServiceHomeInspector } from "./service-home-authority";
import type { UpdateMutationAuthorizer } from "./mutation-guard.mjs";
import { guardedRun, UpdateMutationRefusedError } from "./mutation-guard.mjs";
import {
  freshServingPid, hasRestartableServiceManager, readParentPid, readServiceManagerPid, restartServiceManagerJob,
  supervisionVerdict, unsettledManagerWarning, unsupervisedRuntimeWarning,
} from "./supervised-recovery.mjs";

/**
 * Manager-first recovery for the dashboard update worker (#7043), the `src/update/job.ts` side of
 * what #7074 did for `ocx update`. When the post-update service refresh fails, is not viable, or
 * never serves, the worker asks launchd/systemd to restart the job it already holds before any
 * detached `ocx start`, and counts it only when the serving proxy is that job. It lives beside the
 * worker because `src/update/job.ts` sits at the repository's size cap.
 */
export type ManagerRestartOutcome = "supervised" | "failed" | "unsettled" | "refused";

export interface ManagerRestartDeps {
  serviceHomeAuthorityFn?: UpdateServiceHomeInspector;
  hasManager?: () => boolean;
  restartJob?: () => { ok: true } | { ok: false; reason: string; unsettled?: true; refused?: true };
  managerPid?: () => number | null;
  parentPid?: (pid: number) => number | null;
  readRecord?: () => { pid: number; port: number; hostname?: string } | null;
  probeServing?: (port: number, hostname: string, pid: number, deadlineAt: number) => Promise<boolean>;
  now?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
  deadlineMs?: number;
}

export type ManagerRestartFn = (
  target: { port: number; hostname: string; release?: () => void; authorizeMutation?: UpdateMutationAuthorizer },
  log: (line: string) => void,
) => Promise<ManagerRestartOutcome>;

/**
 * Ask the manager to restart its job and prove the serving proxy is that job. Never throws.
 * `release` frees the update lease first: the manager's child cannot join it (#5760), and the
 * worker reaches this point without a release when it skipped the service repair.
 */
export async function restartServiceManagerAfterUpdate(
  target: { port: number; hostname: string; release?: () => void; authorizeMutation?: UpdateMutationAuthorizer },
  log: (line: string) => void,
  deps: ManagerRestartDeps = {},
): Promise<ManagerRestartOutcome> {
  if (!(deps.hasManager ?? hasRestartableServiceManager)()) return "failed";
  target.release?.();
  const standalone = target.authorizeMutation ? undefined : createUpdateServiceHomePolicy(deps.serviceHomeAuthorityFn ?? inspectUpdateServiceHome, log);
  if (standalone && standalone.initial.kind !== "same") {
    const refusal = updateServiceHomeRefusal(standalone.initial);
    if (refusal) { log(refusal); return "refused"; }
    return "failed";
  }
  const authorizeMutation = target.authorizeMutation ?? standalone!.authorizeMutation;
  if (!authorizeMutation("runtime")) return "refused";
  log("Asking the service manager to restart the background service...");
  const readRecord = deps.readRecord ?? (() => readRuntimePort());
  const probe = deps.probeServing ?? (async (port: number, hostname: string, pid: number, deadlineAt: number) => (
    !!(await proxyIdentityAt(port, { hostname, expectedPid: pid }, { timeoutMs: 1500, deadlineAt, attempts: 1 }))
  ));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleepMs ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const staleRecordPid = readRecord()?.pid ?? null;
  if (!authorizeMutation("service")) return authorizeMutation("runtime") ? "failed" : "refused";
  let restarted: ReturnType<NonNullable<ManagerRestartDeps["restartJob"]>>;
  try { restarted = deps.restartJob ? guardedRun(authorizeMutation, "service", deps.restartJob, []) : restartServiceManagerJob({}, authorizeMutation); }
  catch (error) { if (error instanceof UpdateMutationRefusedError) return "refused"; throw error; }
  if (!restarted.ok && restarted.refused) return "refused";
  const unsettled = !restarted.ok && restarted.unsettled === true;
  let verdict: ReturnType<typeof supervisionVerdict>;
  if (!restarted.ok && !unsettled) {
    // The refusal reason is the manager's stderr: external text, so it never reaches the persisted job.
    verdict = { kind: "failed", reason: "the service manager refused the restart" };
  } else {
    let servingPid: number | null = null;
    const deadline = now() + (deps.deadlineMs ?? 30_000);
    while (servingPid === null && now() < deadline) {
      const current = readRecord();
      if (current && current.port === target.port && freshServingPid(current.pid, staleRecordPid) !== null
        && await probe(current.port, current.hostname ?? target.hostname, current.pid, deadline)) servingPid = current.pid;
      else await sleep(Math.min(100, Math.max(0, deadline - now())));
    }
    verdict = supervisionVerdict({
      servingPid,
      managerPid: (deps.managerPid ?? readServiceManagerPid)(),
      parentPid: deps.parentPid ?? (pid => readParentPid(pid)),
    });
  }
  if (verdict.kind === "supervised") {
    if (!authorizeMutation("publish")) return "refused";
    guardedRun(authorizeMutation, "publish", log, [`Proxy is healthy on port ${target.port} under the service manager (pid ${verdict.managerPid}).`]);
    return "supervised";
  }
  if (unsettled) return "unsettled";
  log(`The service manager did not recover a supervised proxy: ${verdict.reason}.`);
  return "failed";
}

/** Job patch and log line when the manager may still finish its restart: no second proxy is started. */
export function unsettledManagerRestartFailure(port: number) {
  const patch = {
    status: "failed" as const,
    restarted: false,
    error: "the service manager did not finish restarting the proxy; no second proxy was started",
  };
  return [patch, oneLine(unsettledManagerWarning(port))] as const;
}

/** Job patch and log line when only a detached fallback ran for a service-managed install. */
export function unsupervisedRestartFailure(port: number) {
  const patch = {
    status: "failed" as const,
    restarted: false,
    error: `the proxy on port ${port} is running UNSUPERVISED after the update; run 'ocx service repair'`,
  };
  return [patch, oneLine(unsupervisedRuntimeWarning(port))] as const;
}

/** The job store withholds multi-line text as possible vendor output, so join the shared warning. */
function oneLine(text: string): string {
  return text.split("\n").map(line => line.trim()).join(" ");
}
