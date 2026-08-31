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
    expect(uninstallBody).toContain("uninstallServiceDetailed()");
    expect(uninstallBody.indexOf('runStep("service stopped"')).toBeLessThan(uninstallBody.indexOf('runStep("proxy stopped"'));
    expect(uninstallBody.indexOf('runStep("proxy stopped"')).toBeLessThan(uninstallBody.indexOf('runStep("service removed"'));
    expect(uninstallBody.indexOf("await stopProxy(pid);")).toBeLessThan(uninstallBody.indexOf("uninstallServiceDetailed()"));
  });
});
describe("uninstall gates shared teardown on a proven service stop", () => {
  test("the authorization rule, exercised for every failure permutation", async () => {
    const { sharedTeardownAuthorized } = await import("../src/cli/uninstall-plan");
    const base = {
      serviceStop: "stopped" as const,
      proxyProvenDown: true,
      serviceRemoval: "removed" as const,
      respawnWindowVerified: false,
    };
    expect(sharedTeardownAuthorized(base)).toBe(true);
    expect(sharedTeardownAuthorized({ ...base, serviceStop: "absent" })).toBe(true);
    expect(sharedTeardownAuthorized({ ...base, serviceRemoval: "absent" })).toBe(true);
    // Removing the registration does not prove an already-running wrapper died; killing it
    // is best-effort (#764), so the restart window has to be polled first.
    expect(sharedTeardownAuthorized({ ...base, serviceStop: "stopped-respawnable" })).toBe(false);
    expect(sharedTeardownAuthorized({ ...base, serviceStop: "stopped-respawnable", respawnWindowVerified: true })).toBe(true);
    // A manager that refused to stop, or one we could not read, may still be running.
    expect(sharedTeardownAuthorized({ ...base, serviceStop: "failed" })).toBe(false);
    expect(sharedTeardownAuthorized({ ...base, serviceStop: "state-unknown" })).toBe(false);
    // The step itself threw: we know nothing.
    expect(sharedTeardownAuthorized({ ...base, serviceStop: null })).toBe(false);
    // A proxy that could not be PROVEN down — a live orphan with no pid, or an endpoint
    // that would not answer — blocks it. A findLiveProxy miss is not proof.
    expect(sharedTeardownAuthorized({ ...base, proxyProvenDown: false })).toBe(false);
    // A removal that failed used to look like absence on darwin and linux.
    expect(sharedTeardownAuthorized({ ...base, serviceRemoval: "failed" })).toBe(false);
    expect(sharedTeardownAuthorized({ ...base, serviceRemoval: null })).toBe(false);
  });

  test("a removal failure is distinguishable from nothing being installed", async () => {
    const { setUninstallServiceHooksForTests, uninstallServiceDetailed } = await import("../src/service");
    // Windows is the platform whose hooks are injectable; the darwin/linux catch arms that
    // returned the same false as absence are now typed outcomes rather than a boolean.
    setUninstallServiceHooksForTests({
      platform: "win32",
      assertEnvironment: () => {},
      probeWindowsTask: () => ({ status: "absent" }) as never,
      uninstallWindowsTask: () => {},
      nativeStatus: () => "nonexistent",
      uninstallNative: () => {},
      removeInstallState: () => {},
    } as never);
    expect(uninstallServiceDetailed()).toBe("absent");

    const serviceSource = await readText("src/service.ts");
    // The darwin and linux arms return "failed", not the absence value.
    expect(serviceSource).toContain('try { uninstallLaunchd(); removeServiceInstallState(); return "removed"; } catch { return "failed"; }');
    expect(serviceSource).toContain('try { unlinkSync(unitPath()); removeServiceInstallState(); return "removed"; } catch { return "failed"; }');
  });

  test("a live orphan with no pid file blocks the teardown", async () => {
    const cli = await readText("src/cli/index.ts");
    const at = cli.indexOf("async function handleUninstall(");
    const fn = cli.slice(at, at + 9000);
    // A missing pid file is not proof that nothing is serving — the same discovery
    // `ocx stop` performs. Without it, uninstall restored shared config under a live proxy.
    expect(fn).toContain("const live = await findLiveProxy();");
    expect(fn).toContain("observed.proxyProvenDown = await proxyEndpointProvenDown();");
    expect(fn).toContain("no process id could be resolved for it");
    // The orphan-with-no-pid branch THROWS, so `proxyProvenDown` stays false and the
    // authorization rule refuses the shared teardown.
    const orphanBranch = fn.slice(fn.indexOf("const live = await findLiveProxy();"), fn.indexOf("const live = await findLiveProxy();") + 600);
    expect(orphanBranch).toContain("throw new Error(");
    // A findLiveProxy miss is not proof either: it goes through the tri-state probe first.
    expect(orphanBranch).toContain("could not be confirmed down either");
  });

  async function uninstallFn(): Promise<string> {
    const cli = await readText("src/cli/index.ts");
    const at = cli.indexOf("async function handleUninstall(");
    expect(at).toBeGreaterThan(-1);
    return cli.slice(at, at + 9000);
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
    expect(fn).toContain("serviceStop: null,");
    expect(fn).toContain("proxyProvenDown: false,");
    expect(fn).toContain("serviceRemoval: null,");
    expect(fn).toContain("respawnWindowVerified: false,");
    expect(fn).toContain("observed.serviceStop = outcome;");
    expect(fn).toContain("observed.serviceRemoval = outcome;");
    expect(fn).toContain('if (observed.serviceStop === "stopped-respawnable")');
    expect(fn).toContain("observed.respawnWindowVerified = true;");
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
  test("proof covers every distinct endpoint, not just the preferred one", async () => {
    const { endpointsToProve, everyEndpointProvenDown } = await import("../src/cli/uninstall-plan");

    // A stale runtime record pointing at a closed port, and the live proxy on the
    // configured one. Probing only the runtime candidate reports "dead" for a port nobody
    // is using and authorizes the teardown (#3008).
    const endpoints = endpointsToProve({ port: 10999, hostname: "127.0.0.1" }, { port: 10100, hostname: "127.0.0.1" });
    expect(endpoints).toEqual([
      { hostname: "127.0.0.1", port: 10999 },
      { hostname: "127.0.0.1", port: 10100 },
    ]);
    const closedRuntimeLiveConfig = (e: { port: number }) => (e.port === 10999 ? "dead" as const : "live" as const);
    expect(everyEndpointProvenDown(endpoints, closedRuntimeLiveConfig)).toBe(false);
    // A silent listener is not absence either.
    expect(everyEndpointProvenDown(endpoints, e => (e.port === 10999 ? "dead" : "unknown"))).toBe(false);
    // Both definitively dead is the only proof.
    expect(everyEndpointProvenDown(endpoints, () => "dead")).toBe(true);

    // Identical candidates collapse to one; a missing runtime record leaves the config one.
    expect(endpointsToProve({ port: 10100, hostname: "127.0.0.1" }, { port: 10100 })).toHaveLength(1);
    expect(endpointsToProve(null, { port: 10100 })).toEqual([{ hostname: "127.0.0.1", port: 10100 }]);
    // No configured port still yields the default, so the set is never empty in practice.
    expect(endpointsToProve(null, {})).toEqual([{ hostname: "127.0.0.1", port: 10100 }]);
    // An empty set is not proof of anything.
    expect(everyEndpointProvenDown([], () => "dead")).toBe(false);
    // A nonsense runtime port is skipped rather than probed.
    expect(endpointsToProve({ port: 0 }, { port: 10100 })).toEqual([{ hostname: "127.0.0.1", port: 10100 }]);
  });

  test("the respawn window is verified by evidence, not by a silent poll", async () => {
    const cli = await readText("src/cli/index.ts");
    const at = cli.indexOf("async function handleUninstall(");
    const fn = cli.slice(at, at + 9000);
    // proxyStillLiveAfterStop returns null on a timeout as well as on a genuinely dead
    // endpoint, so a respawned-but-unresponsive proxy looked verified-down.
    const windowStep = fn.slice(fn.indexOf('runStep("respawn window verified"'), fn.indexOf('runStep("respawn window verified"') + 900);
    expect(windowStep).toContain("if (!await proxyEndpointProvenDown())");
    expect(windowStep).toContain("could not be confirmed down either");
    expect(windowStep.indexOf("if (!await proxyEndpointProvenDown())"))
      .toBeLessThan(windowStep.indexOf("observed.respawnWindowVerified = true;"));
    // And the proof itself asks every candidate.
    expect(fn).toContain("endpointsToProve(readRuntimePort(), loadConfig())");
    expect(fn).toContain("everyEndpointProvenDown(endpoints, e => probeProxyLiveness(e.port, e.hostname))");
  });
