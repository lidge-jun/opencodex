import { guardedUpdateIo } from "../helpers/update-guarded-io.mjs";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { createUpdateServiceHomePolicy, type UpdateServiceHomeAuthority } from "../../src/update/service-home-policy.mjs";

const helper = readFileSync(repoPath("src/update/job-windows-restart.ts"), "utf8");
const worker = readFileSync(repoPath("src/update/job.ts"), "utf8");
const helperBody = helper.slice(helper.indexOf("export function stopWindowsServiceWrappersBestEffort")).replace("export ", "");
function execute(body: string, deps: object): any {
  // Complete production bodies; module loading and external OS/store observations are injected.
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(body.replaceAll('await import("../service")', "await moduleIo.service()"));
  return new Function("deps", `with(deps){${js}}`)({ ...deps, ...guardedUpdateIo(deps) });
}
const authority = (kind: "same" | "absent" | "unknown" | "foreign"): UpdateServiceHomeAuthority =>
  kind === "foreign" ? { kind, subject: "a".repeat(64) } : { kind };

for (const phase of ["stop", "throwing-stop", "backend-native", "backend-throw"] as const) {
  for (const changed of ["same", "absent", "unknown", "foreign"] as const) {
    test(`Windows wrapper helper checks ${changed} service authority after ${phase}`, () => {
      let home = authority("same");
      const events: string[] = [];
      const homePolicy = createUpdateServiceHomePolicy(() => home, () => {});
      execute(helperBody + ';stopWindowsServiceWrappersBestEffort(homePolicy.authorizeMutation);', {
        homePolicy, process: { platform: "win32" }, join, getConfigDir: () => "/fixture/own",
        readServiceBackend: () => {
          if (phase.startsWith("backend")) home = authority(changed);
          if (phase === "backend-throw") throw new Error("fixture backend read");
          return phase === "backend-native" ? "native" : "scheduler";
        },
        stopWinswService: () => events.push(`native:${home.kind}`),
        stopWindows: () => {
          events.push(`stop:${home.kind}`); home = authority(changed);
          if (phase === "throwing-stop") throw new Error("fixture scheduler stop");
        },
        killWindowsSchedulerWrappers: () => events.push(`kill:${home.kind}`),
      });
      const stable = phase === "backend-native" ? ["native:same"] : phase === "backend-throw" ? ["kill:same"] : ["stop:same", "kill:same"];
      expect(events).toEqual(changed === "same" ? stable : phase.startsWith("backend") ? [] : ["stop:same"]);
      // The same policy must retain unknown/foreign refusal even if registration re-matches.
      home = authority("same");
      expect(homePolicy.authorizeMutation("service")).toBe(changed === "same" || changed === "absent");
    });
  }
}

for (const changed of ["same", "absent", "unknown", "foreign"] as const) {
  test(`complete worker passes its latched authorizer through Windows wrapper recovery: ${changed}`, async () => {
    let home = authority("same");
    const events: string[] = [];
    const from = worker.indexOf("async function restartAfterUpdate("), to = worker.indexOf("/** Compact listen-holder summary", from);
    expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
    const result = await execute(helperBody + worker.slice(from, to)
      + ';return restartAfterUpdate({installer:"npm"},{port:19001,hostname:"127.0.0.1"},io);', {
      createUpdateServiceHomePolicy, join, getConfigDir: () => "/fixture/own",
      process: { platform: "win32", env: {}, pid: 99 }, loadConfig: () => ({}),
      restartCommand: () => ({ bin: "fixture", args: [], display: "fixture" }), updateJob() {},
      RESTART_PORT_RECLAIM_MS: 30000, WINDOWS_SERVICE_REPAIR_TIMEOUT_MS: 1000, RESTART_TIMEOUT_MS: 1000,
      moduleIo: { service: async () => ({ serviceReinstallArgs: () => ["service", "repair"] }) },
      readServiceBackend: () => "scheduler", stopWinswService() {},
      stopWindows: () => { events.push(`stop:${home.kind}`); home = authority(changed); },
      killWindowsSchedulerWrappers: () => events.push(`kill:${home.kind}`),
      io: { serviceHomeAuthorityFn: () => home, serviceInstalledFn: () => true, packageLauncherPathFn: () => "fixture",
        waitForPort: async (_p: unknown, _h: unknown, options: any) => options.mayMutateFn(),
        listListenPidsFn: () => [], verifyOcxFn: () => null, isAliveFn: () => false,
        serviceViableFn: () => false, runService: () => ({ status: 1 }), restartServiceManagerFn: async () => "failed",
        reacquireForDirectStartFn: () => ({ notice: "fixture ownership veto", failed: false }), readPidFn: () => null, spawnStart: () => events.push("spawn") },
    });
    expect(events).toEqual(changed === "same" ? ["stop:same", "kill:same"] : ["stop:same"]);
    if (changed === "unknown" || changed === "foreign") expect(result).toBe(false);
  });
}
