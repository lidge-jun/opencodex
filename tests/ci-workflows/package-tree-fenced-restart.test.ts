/**
 * #5496, in the order it happens to an installed proxy: boot healthy, the package tree is replaced
 * under it, the proxy fences itself, the guard admits the automatic drain-and-restart, an operator
 * running `ocx restart` in that window finds the fenced proxy through attested identity and joins
 * the same restart, and exactly one handoff follows — only while the service home is still owned.
 *
 * Real listener, real guard wiring, real liveness and restart client; only the terminal effects
 * (drain, exit, spawn) and the service-home ownership answer are observed through seams.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { createPackageTreeIntegrityGuard, type PackageTreeObservation } from "../../src/lib/package-tree-integrity";
import { createLocalAttestationSecret } from "../../src/lib/local-management-attestation";
import { SYSTEM_RESTART_CAPABILITY_VERSION } from "../../src/lib/system-restart-contract";
import { requestBoundSystemRestart } from "../../src/cli/system-restart-client";
import { startServer, waitForFailedStartRollback } from "../../src/server";
import { acquireTemporaryDrain, resetLifecycleDrainStateForTests, stopServerListener } from "../../src/server/lifecycle";
import { setSystemRestartIoForTests } from "../../src/server/management/system-restart";
import { findLiveProxy, type LivenessIo } from "../../src/server/proxy-liveness";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { currentServerFixtureConfig, settleServerAuthFixture } from "../helpers/server-auth-fixture";

const TEST_DIR = join(import.meta.dir, ".tmp-package-tree-fenced-restart");
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const BOOT: PackageTreeObservation = { device: 1n, inode: 10n, contentTimeNs: 100n, size: 500n };
const REPLACED: PackageTreeObservation = { ...BOOT, inode: 11n, contentTimeNs: 200n };
const INSTALLED_VERSION = "9.8.7";

let isolatedCodexHome: IsolatedCodexHome | null = null;
let server: ReturnType<typeof startServer> | null = null;
let observation = BOOT;
let ownsServiceHome = true;
let scheduled: Array<() => void | Promise<void>> = [];
let effects: string[] = [];
const secret = createLocalAttestationSecret();

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "test",
    clientIntegrations: { codex: false },
    providers: {
      test: { adapter: "openai-chat", baseUrl: "https://example.test/v1", disabled: true, models: ["gpt-test"] },
    },
  };
}

beforeEach(async () => {
  observation = BOOT;
  ownsServiceHome = true;
  scheduled = [];
  effects = [];
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-package-tree-fenced-restart-");
  setSystemRestartIoForTests({
    getActiveTurnCount: () => 0,
    acquireTemporaryDrain: () => {
      const lease = acquireTemporaryDrain("package-tree-fenced-restart-test");
      if (lease) effects.push("fence");
      return lease;
    },
    beginShutdownDrain: () => { effects.push("shutdown-drain"); return true; },
    schedule: callback => { scheduled.push(callback); },
    scheduleDeadline: () => () => {},
    drainAndShutdown: async () => { effects.push("drain"); },
    // A service child hands off by exiting non-zero; its supervisor starts the one replacement.
    isSupervisedServiceChild: () => true,
    stopListener: () => { effects.push("stop-listener"); },
    spawnStart: () => { effects.push("spawn"); },
    exitProcess: code => { effects.push(`exit:${code}`); },
  });
  saveConfig(currentServerFixtureConfig(config()));
  try {
    server = startServer(0, {
      inspectNativeCodexOwnership: ownedServiceHomeInspection("package-tree fenced restart sandbox"),
      localAttestationSecret: secret,
      packageTreeInstaller: "npm",
      observePackageTree: () => observation,
      packageTreeIntegrityOptions: {
        replacedRestartDelayMs: 0,
        readInstalledVersion: () => INSTALLED_VERSION,
      },
      packageTreeServiceChild: () => true,
      packageTreeServiceHomeOwned: () => ownsServiceHome,
    });
  } catch (error) {
    await waitForFailedStartRollback(error);
    throw error;
  }
});

afterEach(async () => {
  if (server) await stopServerListener(server);
  server = null;
  setSystemRestartIoForTests();
  resetLifecycleDrainStateForTests();
  await settleServerAuthFixture(TEST_DIR, isolatedCodexHome?.path);
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

/** Liveness bound to this home's runtime record for the live listener. */
function ownedLiveness(port: number, recordSecret = secret): LivenessIo {
  const record = { pid: process.pid, port, hostname: "127.0.0.1", attestationSecret: recordSecret };
  return {
    fetchFn: fetch,
    readPidFn: () => process.pid,
    verifyPidFn: candidate => candidate,
    readRuntimeFn: () => record,
    configFn: () => ({ port, hostname: "127.0.0.1" }),
    acceptPackageTreeFenced: true,
  };
}

/** Returns the first fenced body (before the guard settled) and one fetched after it settled. */
async function replaceTreeAndObserveFence(port: number): Promise<{ first: Record<string, unknown>; settled: Record<string, unknown> }> {
  const healthy = await fetch(`http://127.0.0.1:${port}/healthz`);
  expect(healthy.status).toBe(200);
  await healthy.text();
  observation = REPLACED;
  await Bun.sleep(1_100); // outlive the guard's cached healthy observation
  const fenced = await fetch(`http://127.0.0.1:${port}/healthz`);
  expect(fenced.status).toBe(503);
  const first = await fenced.json() as Record<string, unknown>;
  await Promise.resolve(); // the guard verifies the replacement in a microtask
  const again = await fetch(`http://127.0.0.1:${port}/healthz`);
  expect(again.status).toBe(503);
  const settled = await again.json() as Record<string, unknown>;
  return { first, settled };
}

describe("package-tree fence, real order (#5496)", () => {
  test("replace, fence, automatic restart, manual restart joins it, exactly one handoff", async () => {
    const port = server!.port!;
    const io = ownedLiveness(port);
    expect(await findLiveProxy(io)).toMatchObject({ pid: process.pid, port, source: "runtime" });

    const { first, settled } = await replaceTreeAndObserveFence(port);
    // The first observation of a replacement cannot know the install finished.
    expect(first).toMatchObject({ status: "restart_required", error: { code: "package_tree_changed" } });
    expect(first.installedVersion).toBeUndefined();
    expect(settled).toMatchObject({
      status: "restart_required",
      pid: process.pid,
      port,
      restartCapability: SYSTEM_RESTART_CAPABILITY_VERSION,
      installedVersion: INSTALLED_VERSION,
      error: { code: "package_tree_changed" },
    });
    // The guard admitted the automatic restart on its own.
    expect(scheduled).toHaveLength(1);
    expect(effects).toEqual(["fence"]);

    // Default liveness does not call a fenced proxy healthy; opted-in liveness finds it by proof.
    expect(await findLiveProxy({ ...io, acceptPackageTreeFenced: undefined })).toBeNull();
    const fencedLive = await findLiveProxy(io);
    expect(fencedLive).toMatchObject({ pid: process.pid, port, source: "runtime", packageTreeFenced: true });
    // A record with any other secret cannot vouch for the listener.
    expect(await findLiveProxy(ownedLiveness(port, createLocalAttestationSecret()))).toBeNull();

    // `ocx restart` in the same window: attested, installed version matches, request accepted.
    const outcome = await requestBoundSystemRestart(fencedLive!, Date.now() + 10_000, {
      fetchImpl: fetch,
      readRuntime: () => ({ pid: process.pid, port, hostname: "127.0.0.1", attestationSecret: secret }),
      findLive: extra => findLiveProxy({ ...io, ...extra }),
      cliVersion: INSTALLED_VERSION,
    });
    expect(outcome).toEqual({ accepted: true });
    // It joined the pending restart instead of scheduling a second one.
    expect(scheduled).toHaveLength(1);

    await scheduled[0]!();
    expect(effects.filter(effect => effect.startsWith("exit:"))).toEqual(["exit:1"]);
    expect(effects).not.toContain("spawn");
  });

  test("a service child that lost its service home keeps the fence and never hands off", async () => {
    const port = server!.port!;
    await replaceTreeAndObserveFence(port);
    expect(scheduled).toHaveLength(1);

    ownsServiceHome = false;
    await scheduled[0]!();
    expect(effects.some(effect => effect.startsWith("exit:") || effect === "spawn")).toBe(false);
    const stillFenced = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(stillFenced.status).toBe(503);
    await stillFenced.text();
  });
});

describe("installed version is reported only for a settled replacement (#5496)", () => {
  test("undefined while the replacement is new or still moving, defined once it held for the debounce", async () => {
    let observed: PackageTreeObservation = BOOT;
    const pending: Array<() => void> = [];
    let clock = 0;
    const guard = createPackageTreeIntegrityGuard(() => observed, () => clock, {
      onReplaced: () => {},
      replacedRestartDelayMs: 5_000,
      schedule: callback => { pending.push(callback); },
      readInstalledVersion: () => INSTALLED_VERSION,
    });
    const runNext = async () => {
      pending.shift()?.();
      await Promise.resolve();
    };

    expect(guard.status()).toEqual({ ok: true });
    expect(guard.installedVersion?.()).toBeUndefined();

    // npm has written a new manifest; the rest of the tree may still be extracting.
    observed = REPLACED;
    clock += 2_000;
    expect(guard.status()).toEqual({ ok: false, reason: "package_tree_replaced" });
    expect(guard.installedVersion?.()).toBeUndefined();

    // The identity held for the full interval: settled.
    await runNext();
    expect(guard.installedVersion?.()).toBe(INSTALLED_VERSION);

    // Any later movement withdraws it again.
    observed = { ...REPLACED, contentTimeNs: 300n };
    expect(guard.installedVersion?.()).toBeUndefined();
    guard.dispose();
  });
});
