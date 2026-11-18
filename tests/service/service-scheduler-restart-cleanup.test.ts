import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repairService, type RepairServiceDeps } from "../../src/service/repair";
import { buildWindowsTaskXml } from "../../src/service/windows-taskxml";
import { snapshotWindowsSchedulerAssets } from "../../src/service/windows-ops";
import { windowsLauncherVbsPath, windowsServiceScriptPath, windowsTaskXmlPath } from "../../src/service/state";
import * as disconnectedCleanup from "../../src/service/disconnected-client-restart";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { stopProxyForServiceRestart, type HeldRestartReceipt } from "../../src/service/restart-proxy-stop";
import { assertSchedulerRestartTargetAllowed, schedulerReplacementServing, stopTrackedProxyForServiceRestart } from "../../src/service/orchestration";
import { ProxyOwnershipRefusedError } from "../../src/lib/process-control";

const sid = "S-1-5-21-111-222-333-1001", launcher = "C:\\fixture\\launcher.vbs";
const healthy = buildWindowsTaskXml("fixture.cmd", launcher, undefined, sid);

async function scenario(run: (deps: RepairServiceDeps, effects: string[]) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "ocx-scheduler-cleanup-"));
  const effects: string[] = [];
  const deps: RepairServiceDeps = {
    platform: "win32", verb: "restart", configDir: () => root,
    inspectSupervision: () => ({ kind: "none" }),
    diagnose: () => ({ supported: true, installed: true, enabled: true, running: true, viable: true,
      startable: true, stale: false, conflict: false, backend: "scheduler", summary: "fixture" }),
    readOwnership: () => ({ kind: "none", revision: 0 }), assertEnv: () => {}, assertAuth: () => {},
    selectRuntime: () => ({ path: process.execPath, source: "override", overrideEnv: "OPENCODEX_BUN_PATH" }),
    assertRuntimeWritable: () => {}, launcherPathDiagnostic: () => null,
    readSchedulerXml: () => healthy, resolveExpectedUserId: () => sid, schedulerLauncher: launcher,
    prepareDisconnectedClientRestart: async () => {},
    stopScheduler: () => { effects.push("stop"); }, killServiceWrappers: () => { effects.push("wrappers"); },
    stopTrackedProxy: async () => { effects.push("tracked"); },
    schedulerProxyStillLive: async () => { effects.push("verify-stopped"); return null; },
    writeSchedulerAssets: () => { effects.push("assets"); }, startScheduler: () => { effects.push("start"); },
    writeSchedulerState: () => { effects.push("state"); },
    reregisterScheduler: async () => { throw new Error("unexpected reregister"); }, settleSchedulerRead: () => {},
  };
  try { await run(deps, effects); } finally { removeTreeWithRetry(root); }
}

test("scheduler restart stops the tracked proxy before wrapper cleanup and verifies before replacement", async () => {
  await scenario(async (deps, effects) => {
    await repairService(deps);
    // The wrappers still supervise the proxy until it accepted its stop (#8416).
    expect(effects).toEqual(["stop", "tracked", "wrappers", "verify-stopped", "assets", "start", "state"]);
  });
});

test("a Home or connected Child proxy that survives schtasks /end is stopped by its tracked pid, and restart completes", async () => {
  await scenario(async (deps, effects) => {
    let trackedStopped = false;
    deps.stopTrackedProxy = async () => { effects.push("tracked"); trackedStopped = true; };
    deps.schedulerProxyStillLive = async () => { effects.push("verify-stopped"); return trackedStopped ? null : { port: 10100 }; };
    await repairService(deps);
    expect(effects).toEqual(["stop", "tracked", "wrappers", "verify-stopped", "assets", "start", "state"]);
  });
});

test("disconnected scheduler callback shares one guarded scheduler stop with ordinary restart", async () => {
  await scenario(async (deps, effects) => {
    deps.prepareDisconnectedClientRestart = undefined;
    const cleanup = spyOn(disconnectedCleanup, "prepareDisconnectedClientServiceRestart").mockImplementation(async callbacks => {
      await callbacks.stopManager();
      effects.push("client-exited");
    });
    try {
      await repairService(deps);
      expect(effects).toEqual(["stop", "client-exited", "tracked", "wrappers", "verify-stopped", "assets", "start", "state"]);
    } finally { cleanup.mockRestore(); }
  });
});

test("surviving scheduler proxy refuses replacement after owned wrapper cleanup and a second stop", async () => {
  await scenario(async (deps, effects) => {
    deps.schedulerProxyStillLive = async () => ({ port: 10100 });
    await expect(repairService(deps)).rejects.toThrow("still running");
    expect(effects).toEqual(["stop", "tracked", "wrappers", "tracked"]);
  });
});

test("a refused tracked stop leaves the wrappers that supervise the proxy in place", async () => {
  await scenario(async (deps, effects) => {
    deps.stopTrackedProxy = async () => { effects.push("tracked"); throw new Error("proxy refused the stop"); };
    await expect(repairService(deps)).rejects.toThrow("proxy refused the stop");
    expect(effects).toEqual(["stop", "tracked"]);
  });
});

test("a child a wrapper respawned before cleanup is stopped once more, and restart completes", async () => {
  await scenario(async (deps, effects) => {
    let checks = 0;
    deps.schedulerProxyStillLive = async () => { effects.push("verify-stopped"); return ++checks === 1 ? { port: 10100 } : null; };
    await repairService(deps);
    expect(effects).toEqual(["stop", "tracked", "wrappers", "verify-stopped", "tracked", "verify-stopped", "assets", "start", "state"]);
  });
});

test.each(["ownership", "registration"])("scheduler %s change during stop preserves wrappers and replacement", async mode => {
  await scenario(async (deps, effects) => {
    let changed = false;
    deps.readOwnership = () => ({ kind: "none", revision: changed && mode === "ownership" ? 1 : 0 });
    deps.readSchedulerXml = () => changed && mode === "registration" ? "<Task/>" : healthy;
    deps.stopScheduler = () => { effects.push("stop"); changed = true; };
    await expect(repairService(deps)).rejects.toThrow();
    expect(effects).toEqual(["stop"]);
  });
});

test("wrapper cleanup failure refuses scheduler replacement", async () => {
  await scenario(async (deps, effects) => {
    deps.killServiceWrappers = () => { throw new Error("wrapper cleanup refused"); };
    await expect(repairService(deps)).rejects.toThrow("wrapper cleanup refused");
    expect(effects).toEqual(["stop", "tracked"]);
  });
});

test("unrecognized scheduler registration refuses before wrapper cleanup", async () => {
  await scenario(async (deps, effects) => {
    deps.readSchedulerXml = () => '<Task><Actions><Exec><Command>foreign.exe</Command></Exec></Actions></Task>';
    await expect(repairService(deps)).rejects.toThrow("not a recognized legacy");
    expect(effects).toEqual([]);
  });
});

test("ownership changing during awaited stop verification refuses replacement", async () => {
  await scenario(async (deps, effects) => {
    let revision = 0;
    deps.readOwnership = () => ({ kind: "none", revision });
    deps.schedulerProxyStillLive = async () => { revision++; return null; };
    await expect(repairService(deps)).rejects.toThrow("ownership changed");
    expect(effects).toEqual(["stop", "tracked", "wrappers"]);
  });
});

test("a failed asset rewrite after the stop puts the old assets back and restarts the verified registration", async () => {
  await scenario(async (deps, effects) => {
    deps.snapshotSchedulerAssets = () => { effects.push("snapshot"); return () => { effects.push("restore-assets"); }; };
    deps.writeSchedulerAssets = () => { effects.push("assets"); throw Object.assign(new Error("fixture read-only asset"), { code: "EACCES" }); };
    await expect(repairService(deps)).rejects.toThrow("fixture read-only asset");
    expect(effects).toEqual(["snapshot", "stop", "tracked", "wrappers", "verify-stopped", "assets", "restore-assets", "start"]);
  });
});

test.each(["restart", "repair"] as const)("an unreadable asset snapshot refuses %s before anything is stopped", async verb => {
  await scenario(async (deps, effects) => {
    deps.verb = verb;
    deps.snapshotSchedulerAssets = () => { throw Object.assign(new Error("fixture EACCES"), { code: "EACCES" }); };
    await expect(repairService(deps)).rejects.toThrow("fixture EACCES");
    expect(effects).toEqual([]);
  });
});

test("a registration that changed after the failed asset rewrite is preserved and not started", async () => {
  await scenario(async (deps, effects) => {
    let changed = false;
    deps.readSchedulerXml = () => changed ? "<Task/>" : healthy;
    deps.snapshotSchedulerAssets = () => () => { effects.push("restore-assets"); };
    deps.writeSchedulerAssets = () => { changed = true; throw new Error("fixture read-only asset"); };
    const failure = await repairService(deps).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(error => (error as Error).message).join("\n")).toContain("fixture read-only asset");
    expect(effects).toEqual(["stop", "tracked", "wrappers", "verify-stopped", "restore-assets"]);
  });
});

test("the asset snapshot restores changed bytes and removes an asset that did not exist", () => {
  // Pin this test's own config directory: the assets live there.
  const previousHome = process.env.OPENCODEX_HOME;
  const configHome = mkdtempSync(join(tmpdir(), "ocx-scheduler-assets-"));
  process.env.OPENCODEX_HOME = configHome;
  const script = windowsServiceScriptPath(), vbs = windowsLauncherVbsPath(), xml = windowsTaskXmlPath();
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "@echo old\r\n", "utf8");
  writeFileSync(vbs, "\uFEFFold vbs", "utf16le");
  try {
    const restore = snapshotWindowsSchedulerAssets();
    writeFileSync(script, "@echo new\r\n", "utf8");
    writeFileSync(xml, "\uFEFF<Task/>", "utf16le");
    restore();
    expect(readFileSync(script, "utf8")).toBe("@echo old\r\n");
    expect(readFileSync(vbs, "utf16le")).toBe("\uFEFFold vbs");
    expect(existsSync(xml)).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(configHome);
  }
});


test.each([
  { kind: "script", bytes: Buffer.from([0x40, 0x80, 0x0d, 0x0a]) },
  { kind: "launcher", bytes: Buffer.from([0xff, 0xfe, 0x41]) },
])("the asset snapshot restores the original $kind byte for byte, even bytes its encoding cannot round-trip", ({ kind, bytes }) => {
  const previousHome = process.env.OPENCODEX_HOME;
  const configHome = mkdtempSync(join(tmpdir(), "ocx-scheduler-asset-bytes-"));
  process.env.OPENCODEX_HOME = configHome;
  const path = kind === "script" ? windowsServiceScriptPath() : windowsLauncherVbsPath();
  mkdirSync(dirname(path), { recursive: true });
  // A lone 0x80 is not UTF-8 and an odd byte count is not UTF-16LE: decoding either and writing the
  // text back changed what the registered task runs.
  writeFileSync(path, bytes);
  try {
    const restore = snapshotWindowsSchedulerAssets();
    writeFileSync(path, "changed");
    restore();
    expect(readFileSync(path).equals(bytes)).toBe(true);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(configHome);
  }
});

test("a refused second stop after wrapper cleanup says the proxy is unsupervised and starts nothing", async () => {
  await scenario(async (deps, effects) => {
    let stops = 0;
    deps.stopTrackedProxy = async () => { effects.push("tracked"); if (++stops === 2) throw new Error("proxy refused the stop"); };
    deps.schedulerProxyStillLive = async () => { effects.push("verify-stopped"); return { port: 10100 }; };
    await expect(repairService(deps)).rejects.toThrow("wrappers that supervised it were already removed");
    expect(effects).toEqual(["stop", "tracked", "wrappers", "verify-stopped", "tracked"]);
  });
});

describe("the restart's deferred-teardown receipt", () => {
  const endpoint = { hostname: "127.0.0.1", port: 10100 };
  const run = async (stop: () => Promise<boolean>, over: { record?: boolean; proven?: boolean } = {}) => {
    const events: string[] = [];
    const held: HeldRestartReceipt[] = [];
    const outcome = await stopProxyForServiceRestart(4242, receipt => { held.push(receipt); }, {
      readRuntime: () => over.record === false ? null : { port: 10100 },
      prove: async (_pid, at) => { events.push("prove:" + at.port); return over.proven ?? true; },
      claim: () => { events.push("claim"); return "a".repeat(32); },
      clear: nonce => { events.push("clear:" + nonce.length); return true; },
      stop: async (_pid, io) => { events.push("stop:" + String(io?.deferSharedTeardownNonce?.length) + ":" + String(io?.runtimeEndpointOnly)); return stop(); },
    }).then(value => String(value), (error: Error) => "throw:" + error.constructor.name + ":" + error.message.slice(0, 40));
    return { outcome, events, held };
  };

  test("an accepted stop keeps the receipt for the caller to release once a replacement serves", async () => {
    expect(await run(async () => true)).toEqual({ outcome: "true", events: ["prove:10100", "claim", "stop:32:true"], held: [{ nonce: "a".repeat(32), pid: 4242, endpoint }] });
  });

  test("the proof and the stop share one destination, and a forced stop needs the same verified process", async () => {
    const proved: string[] = [];
    let gate: (() => boolean) | undefined;
    let verified = 4242;
    await stopProxyForServiceRestart(4242, () => {}, {
      readRuntime: () => ({ port: 10100, hostname: "localhost" }),
      prove: async (_pid, at) => { proved.push(at.hostname + ":" + at.port); return true; },
      claim: () => "b".repeat(32),
      verify: () => verified,
      stop: async (_pid, io) => { proved.push("post:" + io?.runtimeEndpoint?.hostname); gate = io?.mayTerminate; return true; },
    });
    expect(proved).toEqual(["127.0.0.1:10100", "post:127.0.0.1"]);
    expect(gate?.()).toBe(true);
    verified = 5151;
    expect(gate?.()).toBe(false);
  });

  test("a refusal deferred nothing, so it releases the receipt and propagates", async () => {
    const result = await run(async () => { throw new ProxyOwnershipRefusedError("refused", "respawnable_service"); });
    expect(result.outcome.startsWith("throw:ProxyOwnershipRefusedError")).toBe(true);
    expect(result.events).toEqual(["prove:10100", "claim", "stop:32:true", "clear:32"]);
    expect(result.held).toEqual([]);
  });

  test("an ambiguous failure keeps the receipt: the proxy may already have exited keeping routing", async () => {
    const result = await run(async () => { throw new Error("process 4242 did not exit"); });
    expect(result.outcome.startsWith("throw:Error")).toBe(true);
    expect(result.held).toEqual([{ nonce: "a".repeat(32), pid: 4242, endpoint }]);
  });

  test("without this home's record or a fresh attestation, no token is sent, nothing is claimed and nothing is stopped", async () => {
    const unrecorded = await run(async () => true, { record: false });
    expect(unrecorded.outcome).toStartWith("throw:Error:No runtime record of this home names");
    expect(unrecorded.events).toEqual([]);
    const unproven = await run(async () => true, { proven: false });
    expect(unproven.outcome).toStartWith("throw:Error:Proxy 4242 could not prove it serves");
    expect(unproven.events).toEqual(["prove:10100"]);
    expect([...unrecorded.held, ...unproven.held]).toEqual([]);
  });

  test("the replacement check counts only this home's freshly published, healthy, attested proxy on the receipt's endpoint", async () => {
    let clock = 0;
    const check = async (steps: Array<{ record: { pid: number; port: number } | null; identity?: { pid: number | null; packageTreeFenced?: true } | null; proven?: boolean }>, window = 10_000) => {
      clock = 0;
      let step = steps[0]!;
      let index = 0;
      return schedulerReplacementServing(endpoint, [4242], {
        readRecord: () => { step = steps[Math.min(index++, steps.length - 1)]!; return step.record; },
        identityAt: async () => step.identity ?? null,
        prove: async () => step.proven ?? false,
        now: () => clock, sleep: async ms => { clock += ms; }, windowMs: window,
      });
    };
    // The stopped proxy's own record, a record for another port, a fenced answer, a pid mismatch,
    // an unproven listener: none counts. Then the published replacement proves itself.
    expect(await check([
      { record: { pid: 4242, port: 10100 }, identity: { pid: 4242 }, proven: true },
      { record: { pid: 5151, port: 10200 }, identity: { pid: 5151 }, proven: true },
      { record: { pid: 5151, port: 10100 }, identity: { pid: 5151, packageTreeFenced: true }, proven: true },
      { record: { pid: 5151, port: 10100 }, identity: { pid: 6161 }, proven: true },
      { record: { pid: 5151, port: 10100 }, identity: { pid: 5151 }, proven: false },
      { record: { pid: 5151, port: 10100 }, identity: { pid: 5151 }, proven: true },
    ])).toBe(true);
    // A listener that names a live pid but cannot prove the record's secret never releases it.
    expect(await check([{ record: { pid: 5151, port: 10100 }, identity: { pid: 5151 }, proven: false }], 3_000)).toBe(false);
    expect(await check([{ record: null }], 2_000)).toBe(false);
  });

  test("a Link connection that appears after the restart began refuses every later tracked stop", async () => {
    await expect(stopTrackedProxyForServiceRestart(() => {}, { linkChild: () => true })).rejects.toThrow("unauthenticated loopback port");
  });

  test("a live Child connected over a Remote Link is refused before anything changes", async () => {
    await expect(assertSchedulerRestartTargetAllowed({ linkChild: () => true, findProxy: async () => ({ pid: 1, port: 10100 }) }))
      .rejects.toThrow("unauthenticated loopback port");
    await assertSchedulerRestartTargetAllowed({ linkChild: () => true, findProxy: async () => null });
    let probed = false;
    await assertSchedulerRestartTargetAllowed({ linkChild: () => false, findProxy: async () => { probed = true; return {}; } });
    expect(probed).toBe(false);
    await expect(assertSchedulerRestartTargetAllowed({ linkChild: () => { throw new Error("unreadable"); } })).rejects.toThrow("could not be read");
    await scenario(async (deps, effects) => {
      deps.assertSchedulerRestartTarget = async () => { throw new Error("refused linked Child"); };
      await expect(repairService(deps)).rejects.toThrow("refused linked Child");
      expect(effects).toEqual([]);
    });
  });
});
