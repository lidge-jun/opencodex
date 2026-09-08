import { afterEach, describe, expect, test } from "bun:test";
import {
  setUninstallServiceHooksForTests,
  uninstallServiceIfInstalled,
} from "../../src/service";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../helpers/repo-root";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeOwnedConfigAfterDesktopCleanup, type UninstallClientStateDeps } from "../../src/cli/uninstall-client-state";
import { assertClientLifecycleHeld, withClientLifecycle, withClientLifecycleSync, type ClientLifecycleHeld } from "../../src/client/lifecycle-lock";
import type { UninstallObservation } from "../../src/cli/uninstall-plan";
import type { DesktopDisconnectReceipt } from "../../src/claude/desktop-remote-store";

const root = pathToFileURL(repoRoot() + "/");

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
    expect(cli).toContain("await removeOwnedConfigAfterDesktopCleanup(observed)");
    expect(cli).not.toContain("removeOwnedConfigState(getConfigDir())");
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
    const { sharedTeardownAuthorized } = await import("../../src/cli/uninstall-plan");
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
    const { setUninstallServiceHooksForTests, uninstallServiceDetailed } = await import("../../src/service");
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
    const { endpointsToProve, everyEndpointProvenDown } = await import("../../src/cli/uninstall-plan");

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

const safeTeardown: UninstallObservation = {
  serviceStop: "stopped", serviceRemoval: "removed", proxyProvenDown: true, respawnWindowVerified: false,
};
const cleanupOwner = {
  serverUrl: "https://hub.example", apiKeyId: "fixture-client", connectedAt: "2026-09-06T00:00:00.000Z",
};
const connectedFixture: ReturnType<UninstallClientStateDeps["readConnection"]> = {
  kind: "connected",
  value: {
    ...cleanupOwner, managementUrl: "https://hub.example", managementTransport: "direct",
    selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    tokenFingerprint: "a".repeat(64), protocolVersion: 1,
  },
};
function disconnectReceipt(phase: DesktopDisconnectReceipt["phase"], keepCatalog = false): DesktopDisconnectReceipt {
  return { version: 1, owner: cleanupOwner, tokenFingerprint: "a".repeat(64), phase, keepCatalog };
}

function uninstallFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ocx-uninstall-client-"));
  const configDir = join(fixtureRoot, "config");
  const lockPath = join(fixtureRoot, "runtime", "lifecycle.sqlite");
  mkdirSync(join(configDir, "desktop-remote"), { recursive: true });
  const sentinels = ["config.json", "service-api-token", "desktop-remote/state.json", "desktop-remote/baseline.json", "desktop-remote/disconnect.json"];
  for (const [index, path] of sentinels.entries()) writeFileSync(join(configDir, path), `fixture-sentinel-${index}\n`, { mode: 0o600 });
  const fixture: {
    connection: ReturnType<UninstallClientStateDeps["readConnection"]>;
    desktop: ReturnType<UninstallClientStateDeps["inspectDesktop"]>;
    receipt: ReturnType<UninstallClientStateDeps["readReceipt"]>;
    beforeFinalLock?: () => void;
    beforeDisconnectLock?: () => void;
    duringCleanup?: () => Promise<void>;
    duringRemove?: () => void;
    finishCleanup: boolean;
    lease?: ClientLifecycleHeld;
    calls: { read: number; cleanup: number; remove: number; finalLock: number };
    cleanupOptions: Array<Parameters<UninstallClientStateDeps["disconnect"]>[0]>;
  } = {
    connection: { kind: "disconnected" }, desktop: { kind: "absent" }, receipt: { kind: "absent" },
    finishCleanup: true, calls: { read: 0, cleanup: 0, remove: 0, finalLock: 0 }, cleanupOptions: [],
  };
  const deps: UninstallClientStateDeps = {
    readConnection: () => { fixture.calls.read++; return fixture.connection; },
    inspectDesktop: () => fixture.desktop,
    readReceipt: () => fixture.receipt,
    // This is a callable cleanup seam, with the same REAL SQLite L as the final
    // removal. If uninstall incorrectly holds L over disconnect, this fails busy.
    disconnect: async options => {
      fixture.calls.cleanup++;
      fixture.cleanupOptions.push(options);
      fixture.beforeDisconnectLock?.();
      await withClientLifecycle(async held => {
        assertClientLifecycleHeld(held);
        const actualOwner = fixture.connection.kind === "connected" ? fixture.connection.value
          : fixture.receipt.kind === "valid" ? fixture.receipt.value.owner : undefined;
        if (options?.expectedOwner && (!actualOwner
          || actualOwner.apiKeyId !== options.expectedOwner.apiKeyId
          || actualOwner.serverUrl !== options.expectedOwner.serverUrl
          || actualOwner.connectedAt !== options.expectedOwner.connectedAt)) throw new Error("client_disconnect_expected_owner_changed");
        await fixture.duringCleanup?.();
        if (!fixture.finishCleanup) return;
        fixture.connection = { kind: "disconnected" };
        fixture.desktop = { kind: "absent" };
        fixture.receipt = { kind: "valid", value: disconnectReceipt("complete", options?.keepCatalog) };
      }, { lockPath });
    },
    withLifecycle: async work => {
      fixture.calls.finalLock++;
      fixture.beforeFinalLock?.();
      return withClientLifecycle(async held => {
        fixture.lease = held;
        try { return await work(held); }
        finally { fixture.lease = undefined; }
      }, { lockPath });
    },
    remove: () => {
      // Real destructive work is confined to this fixture, never getConfigDir().
      assertClientLifecycleHeld(fixture.lease!);
      fixture.calls.remove++;
      fixture.duringRemove?.();
      rmSync(configDir, { recursive: true });
      return { status: "removed", residualPaths: [] };
    },
  };
  const bytes = () => sentinels.map(path => readFileSync(join(configDir, path), "utf8"));
  return { fixtureRoot, configDir, lockPath, fixture, deps, bytes };
}

async function withUninstallFixture(work: (f: ReturnType<typeof uninstallFixture>) => Promise<void>) {
  const f = uninstallFixture();
  try { await work(f); }
  finally { rmSync(f.fixtureRoot, { recursive: true, force: true }); }
}

describe("uninstall client cleanup before owner-state deletion", () => {
  test("teardown refusal occurs before even reading or cleaning client state", async () => {
    await withUninstallFixture(async f => {
      f.fixture.connection = connectedFixture;
      const before = f.bytes();
      await expect(removeOwnedConfigAfterDesktopCleanup({ ...safeTeardown, proxyProvenDown: false }, f.deps))
        .rejects.toThrow("teardown is not proven");
      expect(f.fixture.calls).toEqual({ read: 0, cleanup: 0, remove: 0, finalLock: 0 });
      expect(f.bytes()).toEqual(before);
      expect(existsSync(f.lockPath)).toBe(false);
    });
  });

  test.each(["invalid", "mismatched", "unsafe-desktop", "unsafe-receipt", "orphan-active", "orphan-pending", "orphan-restored", "foreign-desktop", "foreign-receipt"] as const)(
    "%s refuses cleanup/removal and preserves config, token and journal bytes", async scenario => {
      await withUninstallFixture(async f => {
        const before = f.bytes();
        if (scenario === "invalid" || scenario === "mismatched") f.fixture.connection = { kind: scenario, reason: "fixture" };
        else if (scenario === "unsafe-desktop") f.fixture.desktop = { kind: "unsafe" };
        else if (scenario === "unsafe-receipt") f.fixture.receipt = { kind: "unsafe" };
        else if (scenario.startsWith("orphan-")) {
          f.fixture.desktop = { kind: scenario === "orphan-active" ? "active" : scenario === "orphan-pending" ? "pending" : "restored", owner: cleanupOwner };
        } else {
          f.fixture.connection = connectedFixture;
          const foreign = { ...cleanupOwner, apiKeyId: "different-client" };
          if (scenario === "foreign-desktop") f.fixture.desktop = { kind: "active", owner: foreign };
          else f.fixture.receipt = { kind: "valid", value: { ...disconnectReceipt("prepared"), owner: foreign } };
        }
        await expect(removeOwnedConfigAfterDesktopCleanup(safeTeardown, f.deps)).rejects.toThrow("Client cleanup refused");
        expect(f.fixture.calls.cleanup).toBe(0);
        expect(f.fixture.calls.remove).toBe(0);
        expect(f.bytes()).toEqual(before);
      });
    },
  );

  test("a cleanup exception propagates, preserves sentinels and releases L", async () => {
    await withUninstallFixture(async f => {
      f.fixture.connection = connectedFixture;
      f.fixture.desktop = { kind: "active", owner: cleanupOwner };
      f.fixture.duringCleanup = async () => { throw new Error("fixture cleanup failed"); };
      const before = f.bytes();
      await expect(removeOwnedConfigAfterDesktopCleanup(safeTeardown, f.deps)).rejects.toThrow("fixture cleanup failed");
      expect(f.fixture.calls.cleanup).toBe(1);
      expect(f.fixture.calls.remove).toBe(0);
      expect(f.bytes()).toEqual(before);
      withClientLifecycleSync(held => assertClientLifecycleHeld(held), { lockPath: f.lockPath });
    });
  });

  test("a cleanup that returns while connected does not authorize removal", async () => {
    await withUninstallFixture(async f => {
      f.fixture.connection = connectedFixture;
      f.fixture.finishCleanup = false;
      const before = f.bytes();
      await expect(removeOwnedConfigAfterDesktopCleanup(safeTeardown, f.deps)).rejects.toThrow("changed before removal");
      expect(f.fixture.calls.cleanup).toBe(1);
      expect(f.fixture.calls.remove).toBe(0);
      expect(f.bytes()).toEqual(before);
    });
  });

  test("a replacement connection before disconnect claims L survives uninstall", async () => {
    await withUninstallFixture(async f => {
      f.fixture.connection = connectedFixture;
      const replacement = { ...connectedFixture.value, apiKeyId: "replacement-client" };
      f.fixture.beforeDisconnectLock = () => withClientLifecycleSync(() => {
        f.fixture.connection = { kind: "connected", value: replacement };
        f.fixture.desktop = { kind: "active", owner: replacement };
      }, { lockPath: f.lockPath });
      const before = f.bytes();
      await expect(removeOwnedConfigAfterDesktopCleanup(safeTeardown, f.deps))
        .rejects.toThrow("client_disconnect_expected_owner_changed");
      expect(f.fixture.connection).toEqual({ kind: "connected", value: replacement });
      expect(f.fixture.calls.remove).toBe(0);
      expect(f.bytes()).toEqual(before);
      expect(f.fixture.cleanupOptions[0]?.expectedOwner).toEqual(cleanupOwner);
    });
  });

  test.each([false, true])("an interrupted disconnect resumes its frozen keepCatalog=%s choice", async keepCatalog => {
    await withUninstallFixture(async f => {
      f.fixture.receipt = { kind: "valid", value: disconnectReceipt("connection_cleared", keepCatalog) };
      f.fixture.desktop = { kind: "pending", owner: cleanupOwner };
      expect(await removeOwnedConfigAfterDesktopCleanup(safeTeardown, f.deps)).toEqual({ status: "removed", residualPaths: [] });
      expect(f.fixture.cleanupOptions).toEqual([{ keepCatalog, expectedOwner: cleanupOwner }]);
      expect(f.fixture.calls.cleanup).toBe(1);
      expect(f.fixture.calls.remove).toBe(1);
      expect(f.fixture.receipt).toEqual({ kind: "valid", value: disconnectReceipt("complete", keepCatalog) });
    });
  });

  test.each(["connected", "invalid", "mismatched", "desktop-pending", "unsafe-desktop", "unsafe-receipt", "pending-receipt"] as const)(
    "the final L-held recheck refuses racing %s state", async scenario => {
      await withUninstallFixture(async f => {
        f.fixture.connection = connectedFixture;
        const before = f.bytes();
        f.fixture.beforeFinalLock = () => withClientLifecycleSync(held => {
          assertClientLifecycleHeld(held);
          if (scenario === "connected") f.fixture.connection = connectedFixture;
          else if (scenario === "invalid" || scenario === "mismatched") f.fixture.connection = { kind: scenario, reason: "fixture race" };
          else if (scenario === "desktop-pending") f.fixture.desktop = { kind: "pending", owner: cleanupOwner };
          else if (scenario === "unsafe-desktop") f.fixture.desktop = { kind: "unsafe" };
          else if (scenario === "unsafe-receipt") f.fixture.receipt = { kind: "unsafe" };
          else f.fixture.receipt = { kind: "valid", value: disconnectReceipt("prepared") };
        }, { lockPath: f.lockPath });
        await expect(removeOwnedConfigAfterDesktopCleanup(safeTeardown, f.deps)).rejects.toThrow("changed before removal");
        expect(f.fixture.calls.cleanup).toBe(1);
        expect(f.fixture.calls.remove).toBe(0);
        expect(f.bytes()).toEqual(before);
      });
    },
  );

  test.each(["standalone", "connected"] as const)("an already-held real L refuses %s cleanup/removal", async mode => {
    await withUninstallFixture(async f => {
      if (mode === "connected") f.fixture.connection = connectedFixture;
      const before = f.bytes();
      await withClientLifecycle(async () => {
        await expect(removeOwnedConfigAfterDesktopCleanup(safeTeardown, f.deps)).rejects.toThrow("client_lifecycle_busy");
        expect(f.fixture.calls.read).toBe(1); // preflight only
        expect(f.fixture.calls.remove).toBe(0);
        expect(f.bytes()).toEqual(before);
      }, { lockPath: f.lockPath });
    });
  });

  test.each(["standalone", "connected", "terminal"] as const)("%s removes exactly once under L and excludes connect/recovery until removal finishes", async mode => {
    await withUninstallFixture(async f => {
      if (mode === "connected") {
        f.fixture.connection = connectedFixture;
        f.fixture.desktop = { kind: "active", owner: cleanupOwner };
      }
      if (mode === "terminal") f.fixture.receipt = { kind: "valid", value: disconnectReceipt("complete", true) };
      let contendersRan = 0;
      let removingLease: ClientLifecycleHeld | undefined;
      f.fixture.duringRemove = () => {
        removingLease = f.fixture.lease;
        assertClientLifecycleHeld(removingLease!);
        for (const operation of ["connect", "recovery"]) {
          expect(() => withClientLifecycleSync(() => {
            contendersRan++;
            writeFileSync(join(f.configDir, "service-api-token"), `fixture-${operation}`);
          }, { lockPath: f.lockPath })).toThrow("client_lifecycle_busy");
        }
        expect(contendersRan).toBe(0);
        expect(f.bytes()).toHaveLength(5);
      };
      expect(await removeOwnedConfigAfterDesktopCleanup(safeTeardown, f.deps)).toEqual({ status: "removed", residualPaths: [] });
      expect(f.fixture.calls.cleanup).toBe(mode === "connected" ? 1 : 0);
      expect(f.fixture.calls.remove).toBe(1);
      expect(existsSync(f.configDir)).toBe(false);
      expect(existsSync(f.lockPath)).toBe(true); // L is outside the directory being removed.
      expect(() => assertClientLifecycleHeld(removingLease!)).toThrow("client_lifecycle_lease_invalid");
      withClientLifecycleSync(held => assertClientLifecycleHeld(held), { lockPath: f.lockPath });
    });
  });
});
