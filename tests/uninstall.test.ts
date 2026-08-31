import { afterEach, describe, expect, test } from "bun:test";
import {
  setUninstallServiceHooksForTests,
  uninstallServiceIfInstalled,
} from "../src/service";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("full uninstall command", () => {
  afterEach(() => setUninstallServiceHooksForTests(null));

  test("CLI exposes a one-shot local state cleanup command", async () => {
    const dispatch = await readText("src/cli/dispatch.ts");

    expect(dispatch).toContain("uninstall: async");
    const cli = await readText("src/cli/index.ts");
    expect(cli).toContain("async function handleUninstall()");
    expect(cli).toContain("uninstallServiceIfInstalled");
    expect(cli).toContain("uninstallCodexShim");
    expect(cli).toContain("restoreNativeCodex");
    expect(cli).toContain("removeOwnedConfigState(getConfigDir())");
    expect(cli).not.toContain("rmSync(getConfigDir()");
  });

  test("CLI exposes explicit legacy history recovery command", async () => {
    const dispatch = await readText("src/cli/dispatch.ts");
    const cli = await readText("src/cli/index.ts");

    expect(dispatch).toContain('"recover-history": async');
    expect(cli).toContain("ocx recover-history --legacy-openai");
    expect(cli).toContain("async function handleRecoverHistory()");
    // The command still performs legacy recovery, but through the serialized
    // history job rather than by calling the writer inline — the operation name
    // is what keeps it distinct from a generic restore, which must not touch the
    // backup manifest this one deliberately leaves alone.
    expect(cli).toContain("recover-legacy-openai");
    expect(cli).toContain("runCodexHistoryJob");
  });

  test("service cleanup has a quiet best-effort helper", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain("export function uninstallServiceIfInstalled()");
    expect(service).toContain("uninstallLaunchd");
    expect(service).toContain("uninstallWindows");
    expect(service).toContain("uninstallSystemd");
  });

  test("native service removal failure propagates without deleting install state", () => {
    const calls: string[] = [];
    let stateRemovals = 0;
    setUninstallServiceHooksForTests({
      platform: "win32",
      assertEnvironment: () => {},
      probeWindowsTask: () => ({ status: "present" }),
      uninstallWindowsTask: () => { calls.push("scheduler"); },
      nativeStatus: () => "started",
      uninstallNative: () => {
        calls.push("native");
        throw new Error("native removal failed");
      },
      removeInstallState: () => { stateRemovals++; },
    });

    expect(() => uninstallServiceIfInstalled()).toThrow("native removal failed");
    expect(calls).toEqual(["scheduler", "native"]);
    expect(stateRemovals).toBe(0);
  });

  test("scheduler removal failure propagates without deleting install state", () => {
    let stateRemovals = 0;
    setUninstallServiceHooksForTests({
      platform: "win32",
      assertEnvironment: () => {},
      probeWindowsTask: () => ({ status: "present" }),
      uninstallWindowsTask: () => { throw new Error("scheduler removal failed"); },
      nativeStatus: () => "nonexistent",
      uninstallNative: () => {},
      removeInstallState: () => { stateRemovals++; },
    });

    expect(() => uninstallServiceIfInstalled()).toThrow("scheduler removal failed");
    expect(stateRemovals).toBe(0);
  });

  test("full uninstall kills the tracked proxy before deleting service assets", async () => {
    const cli = await readText("src/cli/index.ts");
    const uninstallBody = cli.slice(cli.indexOf("async function handleUninstall()"), cli.indexOf("type HealthCheck"));

    expect(uninstallBody).toContain('runStep("service stopped"');
    expect(uninstallBody).toContain('runStep("proxy stopped"');
    expect(uninstallBody).toContain('runStep("service removed"');
    expect(uninstallBody).toContain("await stopProxy(pid);");
    expect(uninstallBody).toContain("uninstallServiceIfInstalled()");
    expect(uninstallBody.indexOf('runStep("service stopped"')).toBeLessThan(uninstallBody.indexOf('runStep("proxy stopped"'));
    expect(uninstallBody.indexOf('runStep("proxy stopped"')).toBeLessThan(uninstallBody.indexOf('runStep("service removed"'));
    expect(uninstallBody.indexOf("await stopProxy(pid);")).toBeLessThan(uninstallBody.indexOf("uninstallServiceIfInstalled()"));
  });
});
describe("uninstall gates shared teardown on a proven service stop", () => {
  test("the authorization rule, exercised for every failure permutation", async () => {
    const { sharedTeardownAuthorized } = await import("../src/cli/uninstall-plan");
    const base = { serviceStop: "stopped" as const, proxyAccountedFor: true, serviceRemoved: true };
    expect(sharedTeardownAuthorized(base)).toBe(true);
    expect(sharedTeardownAuthorized({ ...base, serviceStop: "absent" })).toBe(true);
    // The manager is removed next, so a wrapper that could have respawned cannot.
    expect(sharedTeardownAuthorized({ ...base, serviceStop: "stopped-respawnable" })).toBe(true);
    // A manager that refused to stop, or one we could not read, may still be running.
    expect(sharedTeardownAuthorized({ ...base, serviceStop: "failed" })).toBe(false);
    expect(sharedTeardownAuthorized({ ...base, serviceStop: "state-unknown" })).toBe(false);
    // The step itself threw: we know nothing.
    expect(sharedTeardownAuthorized({ ...base, serviceStop: null })).toBe(false);
    // A proxy that could not be stopped — including a live orphan with no pid — blocks it.
    expect(sharedTeardownAuthorized({ ...base, proxyAccountedFor: false })).toBe(false);
    // So does a manager that could not be removed: it would respawn afterwards.
    expect(sharedTeardownAuthorized({ ...base, serviceRemoved: false })).toBe(false);
  });

  test("a live orphan with no pid file blocks the teardown", async () => {
    const cli = await readText("src/cli/index.ts");
    const at = cli.indexOf("async function handleUninstall(");
    const fn = cli.slice(at, at + 6000);
    // A missing pid file is not proof that nothing is serving — the same discovery
    // `ocx stop` performs. Without it, uninstall restored shared config under a live proxy.
    expect(fn).toContain("const live = await findLiveProxy();");
    expect(fn).toContain("if (!live) { observed.proxyAccountedFor = true; return false; }");
    expect(fn).toContain("no process id could be resolved for it");
    // The orphan-with-no-pid branch THROWS, so `proxyAccountedFor` stays false and the
    // authorization rule refuses the shared teardown.
    const orphanBranch = fn.slice(fn.indexOf("const live = await findLiveProxy();"), fn.indexOf("const live = await findLiveProxy();") + 600);
    expect(orphanBranch).toContain("throw new Error(");
    expect(orphanBranch.indexOf("throw new Error(")).toBeLessThan(orphanBranch.indexOf("observed.proxyAccountedFor = true;", orphanBranch.indexOf("throw new Error(")));
  });

  async function uninstallFn(): Promise<string> {
    const cli = await readText("src/cli/index.ts");
    const at = cli.indexOf("async function handleUninstall(");
    expect(at).toBeGreaterThan(-1);
    return cli.slice(at, at + 6000);
  }

  test("the detailed outcome is consumed, not the boolean collapse", async () => {
    const fn = await uninstallFn();
    // stopServiceIfInstalled returns false for "not installed", "refused to stop" and
    // "state could not be read" alike, so this step reported "not installed" for a manager
    // that might still be running (#3008).
    expect(fn).toContain("stopServiceIfInstalledDetailed()");
    expect(fn).not.toContain("stopServiceIfInstalled()");
    expect(fn).toContain('if (outcome === "absent") return false;');
    expect(fn).toContain('if (outcome === "failed")');
    expect(fn).toContain('if (outcome === "state-unknown")');
  });

  test("shared teardown runs only when nothing that could still serve is unaccounted for", async () => {
    const fn = await uninstallFn();
    // The rule itself is exercised by calling it above; this pins the wiring.
    expect(fn).toContain("if (sharedTeardownAuthorized(observed)) {");
    // Every step that could leave something serving records what it observed, and the
    // fields start pessimistic so a step that throws cannot look like a success.
    expect(fn).toContain("serviceStop: null, proxyAccountedFor: false, serviceRemoved: false");
    expect(fn).toContain("observed.serviceStop = outcome;");
    expect((fn.match(/observed\.proxyAccountedFor = true;/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(fn).toContain("observed.serviceRemoved = true;");
    const gateAt = fn.indexOf("if (sharedTeardownAuthorized(observed)) {");
    expect(gateAt).toBeLessThan(fn.indexOf("native Codex restored", gateAt));
    // The skip is a failure, not a silent pass: the command must exit nonzero and say what
    // to run once the blocker is resolved.
    expect(fn).toContain('failures.push("native Codex restored", "Grok Build config restored");');
    expect(fn).toContain("Skipping shared teardown");
    // Naming only `ocx restore` was wrong: it restores client routing but leaves the
    // service removal and local cleanup this command had not reached.
    expect(fn).toContain("rerun 'ocx uninstall'");
    expect(fn).toContain("interim step");
  });
});
