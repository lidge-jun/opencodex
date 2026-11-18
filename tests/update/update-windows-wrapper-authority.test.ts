import { guardedUpdateIo } from "../helpers/update-guarded-io.mjs";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { createUpdateServiceHomePolicy, type UpdateServiceHomeAuthority } from "../../src/update/service-home-policy.mjs";

const helper = readFileSync(repoPath("src/update/job-windows-restart.ts"), "utf8");
const worker = readFileSync(repoPath("src/update/job.ts"), "utf8");
const helperBody = helper.slice(helper.indexOf("export const WINDOWS_SERVICE_STOP_ABORT")).replaceAll("export ", "");
function execute(body: string, deps: object): any {
  // Complete production bodies; module loading and external OS/store observations are injected.
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(body.replaceAll('await import("../service")', "await moduleIo.service()"));
  return new Function("deps", `with(deps){${js}}`)({ ...deps, ...guardedUpdateIo(deps) });
}
const authority = (kind: "same" | "absent" | "unknown" | "foreign"): UpdateServiceHomeAuthority =>
  kind === "foreign" ? { kind, subject: "a".repeat(64) } : { kind };

for (const scenario of ["refused stop", "unreadable WinSW state", "conflicting scheduler task"]) {
  test(`native backend aborts for ${scenario}`, async () => {
    const homePolicy = createUpdateServiceHomePolicy(() => authority("same"), () => {});
    let checked = 0;
    const result = await execute(helperBody + ";return stopWindowsServiceForRestart(homePolicy.authorizeMutation);", {
      homePolicy, process: { platform: "win32" }, readServiceBackend: () => "native",
      stopWinswService: () => { throw new Error("refused"); },
      checkedStop: async () => { checked++; return scenario === "refused stop" ? "denied" : "unknown"; },
    });
    expect(result).toBe(false);
    expect(checked).toBe(1);
  });
}

/**
 * Part A of the checked stop (#7771) as the updater sees it: the authorizer at entry, the
 * manager stop, then the authorizer again before the wrapper terminate.
 */
function checkedStop(events: string[], home: () => UpdateServiceHomeAuthority, change: () => void) {
  return async (authorize: () => void) => {
    authorize();
    events.push(`stop:${home().kind}`);
    change();
    authorize();
    events.push(`terminate:${home().kind}`);
    return "stopped";
  };
}

for (const phase of ["checked"] as const) {
  for (const changed of ["same", "absent", "unknown", "foreign"] as const) {
    test(`Windows service stop checks ${changed} service authority after ${phase}`, async () => {
      let home = authority("same");
      const events: string[] = [];
      const homePolicy = createUpdateServiceHomePolicy(() => home, () => {});
      const result = await execute(helperBody + ";return stopWindowsServiceForRestart(homePolicy.authorizeMutation);", {
        homePolicy, process: { platform: "win32" },
        readServiceBackend: () => "scheduler",
        stopWinswService: () => events.push(`native:${home.kind}`),
        checkedStop: checkedStop(events, () => home, () => { if (phase === "checked") home = authority(changed); }),
      });
      expect(events).toEqual(changed === "same" ? ["stop:same", "terminate:same"] : ["stop:same"]);
      // Anything but a proven stop aborts the restart.
      expect(result).toBe(changed === "same");
      // The same policy must retain unknown/foreign refusal even if registration re-matches.
      home = authority("same");
      expect(homePolicy.authorizeMutation("service")).toBe(changed === "same" || changed === "absent");
    });
  }
}

for (const outcome of ["survived", "denied", "unknown", "unverified-budget", "absent", "stopped"] as const) {
  test(`Windows service stop aborts the restart unless Part A is stopped or absent: ${outcome}`, async () => {
    const homePolicy = createUpdateServiceHomePolicy(() => authority("same"), () => {});
    const result = await execute(helperBody + ";return stopWindowsServiceForRestart(homePolicy.authorizeMutation);", {
      homePolicy, process: { platform: "win32" }, readServiceBackend: () => "scheduler",
      checkedStop: async (authorize: () => void) => { authorize(); return outcome; },
    });
    expect(result).toBe(outcome === "stopped" || outcome === "absent");
  });
}

for (const changed of ["same", "absent", "unknown", "foreign"] as const) {
  test(`complete worker passes its latched authorizer through the Windows service stop: ${changed}`, async () => {
    let home = authority("same");
    const events: string[] = [];
    let aborted = 0;
    const from = worker.indexOf("async function restartAfterUpdate("), to = worker.indexOf("/** Compact listen-holder summary", from);
    expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
    const result = await execute(helperBody + worker.slice(from, to)
      + ';return restartAfterUpdate({installer:"npm"},{port:19001,hostname:"127.0.0.1"},io);', {
      createUpdateServiceHomePolicy, join, getConfigDir: () => "/fixture/own",
      process: { platform: "win32", env: {}, pid: 99 }, loadConfig: () => ({}),
      restartCommand: () => ({ bin: "fixture", args: [], display: "fixture" }), updateJob() {},
      windowsServiceStopAborted: () => { aborted++; return false; },
      RESTART_PORT_RECLAIM_MS: 30000, WINDOWS_SERVICE_REPAIR_TIMEOUT_MS: 1000, RESTART_TIMEOUT_MS: 1000,
      moduleIo: { service: async () => ({ serviceReinstallArgs: () => ["service", "repair"] }) },
      readServiceBackend: () => "scheduler", stopWinswService() {},
      checkedStop: checkedStop(events, () => home, () => { home = authority(changed); }),
      io: { serviceHomeAuthorityFn: () => home, serviceInstalledFn: () => true, packageLauncherPathFn: () => "fixture",
        waitForPort: async (_p: unknown, _h: unknown, options: any) => options.mayMutateFn(),
        listListenPidsFn: () => [], verifyOcxFn: () => null, isAliveFn: () => false,
        serviceViableFn: () => false, runService: () => ({ status: 1 }), restartServiceManagerFn: async () => "failed",
        reacquireForDirectStartFn: () => ({ notice: "fixture ownership veto", failed: false }), readPidFn: () => null, spawnStart: () => events.push("spawn") },
    });
    expect(events).toEqual(changed === "same" ? ["stop:same", "terminate:same"] : ["stop:same"]);
    // A refused or unproven service stop aborts before reclaim or any start (#7771).
    if (changed !== "same") {
      expect(result).toBe(false);
      expect(aborted).toBe(1);
    }
  });
}
