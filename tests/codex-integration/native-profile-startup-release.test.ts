import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withNativeMainExclusiveClaim } from "../../src/codex/native-main-claim";
import { NativeProfileManager } from "../../src/codex/native-profile-manager";
import type {
  NativeProfileContext,
  NativeProfileRecoveryState,
} from "../../src/codex/native-profile-store";
import {
  completeNativeMainRecovery,
  flushNativeMainStartupReleases,
  isNativeMainTrafficBlocked,
  nativeMainStartupGateSnapshot,
  startNativeMainStartupLifecycle,
  type NativeMainStartupGateDeps,
  type NativeMainStartupLifecycle,
} from "../../src/codex/native-profile-startup";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/*
 * Releasing the last reference to a native-main startup entry must not leave the PROCESS fenced.
 *
 * The gate is process-global and each entry only writes it back while it is still the map's
 * entry of record. Convergence is asynchronous, so a server stopped mid-convergence used to
 * strand its own "native-main admission is fenced (reason: recovery-pending)" state: the guard
 * that would have written the settled verdict back is the entry the release just deleted, and a
 * later server whose config does not sync Codex binds a no-op lifecycle that never touches the
 * gate — so every later native/forward request answered 503 until the process exited. It is the
 * Cross-platform CI shape: several proxy servers start and stop in one Bun process, and since
 * #5694 the default hard lock adds a second exclusive-claim phase that lengthens convergence far
 * enough for a Windows stop to land inside it.
 *
 * These cases pin the outcome — the gate returns to its process-initial state and stays there —
 * rather than the shape of the reset.
 */

const roots: string[] = [];
const started: NativeMainStartupLifecycle[] = [];
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;

// The fake-owner pattern the native-main startup suite uses: the real owner with its ACL hardener
// and retry cadence replaced, so acquisition reaches "held" in a few milliseconds.
const OWNER: NativeMainStartupGateDeps["owner"] = { retryMs: 10, hardenPath: async () => {} };

function restoreEnv(name: "OPENCODEX_HOME" | "CODEX_HOME", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  for (const lifecycle of started.splice(0)) {
    try { await within(lifecycle.release(), "a tracked lifecycle release", 10_000); } catch { /* asserted in the case */ }
  }
  await flushNativeMainStartupReleases();
  // A case that failed between arming and converging can leave its own blocked reason behind.
  // This file owns no service-ownership fence, so a leftover blocked gate is this module's.
  const leftover = nativeMainStartupGateSnapshot();
  if (leftover.status === "blocked" && leftover.homeId !== null) completeNativeMainRecovery(leftover.homeId);
  restoreEnv("OPENCODEX_HOME", previousOpencodexHome);
  restoreEnv("CODEX_HOME", previousCodexHome);
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function barrier(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A fabricated manager: this module reads only the context, recovery, and stage-sweep surface. */
function fabricatedManager(
  context: NativeProfileContext,
  extra: Record<string, unknown> = {},
): NativeProfileManager {
  return {
    context,
    recover: async () => ({ recovered: true }),
    ...extra,
  } as unknown as NativeProfileManager;
}

interface FabricatedHome {
  readonly homeId: string;
  readonly context: NativeProfileContext;
  readonly manager: NativeProfileManager;
}

function fabricatedHome(homeId: string): FabricatedHome {
  // Canonical dir: the auth-temp scrub compares realpath against the path it was given.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-native-startup-release-")));
  roots.push(root);
  const codexHome = join(root, "codex");
  const configDir = join(root, "opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  // No config.json on purpose: the default config, whose absent `codexMainAccountHardLock` is the
  // default-on hard lock this regression is about. Nothing here writes config.toml either, so the
  // pinned `authPath` stays absent and the policy binding is a no-op read.
  process.env.OPENCODEX_HOME = configDir;
  process.env.CODEX_HOME = codexHome;
  const context = {
    codexHome,
    homeId,
    authPath: join(codexHome, "auth.json"),
    stagingRoot: join(configDir, "native-main-profile-staging"),
  } as unknown as NativeProfileContext;
  return { homeId, context, manager: fabricatedManager(context) };
}

function startLifecycle(deps: NativeMainStartupGateDeps): NativeMainStartupLifecycle {
  const lifecycle = startNativeMainStartupLifecycle(deps);
  started.push(lifecycle);
  return lifecycle;
}

describe("a released native-main startup entry cannot leave the process fenced", () => {
  test("a release during recovery resets the gate and ignores the convergence that follows", async () => {
    const f = fabricatedHome("release-during-recovery-home");
    const recovery = barrier();
    const recoveryEntered = barrier();
    let recoveryState: NativeProfileRecoveryState = "journal";
    const lifecycle = startLifecycle({
      manager: f.manager,
      probeRecoveryState: () => recoveryState,
      beforeRecovery: async () => { recoveryEntered.open(); await recovery.promise; recoveryState = "none"; },
      owner: OWNER,
    });
    let flight: Promise<void> | undefined;
    try {
      // The gate closes synchronously, before ownership is even established.
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: f.homeId,
        reason: "recovery-pending",
      });
      expect(isNativeMainTrafficBlocked()).toBe(true);

      await within(recoveryEntered.promise, "the owned recovery phase to start");
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: f.homeId,
        reason: "recovery-pending",
      });

      flight = lifecycle.release();
      // Synchronous, before any await inside the release: the entry is gone, so its gate goes too.
      expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId: null });
      expect(isNativeMainTrafficBlocked()).toBe(false);

      // The convergence already in flight now completes normally. It belongs to the released
      // generation, so it must not re-fence the process the release just reopened.
      recovery.open();
      await within(flight, "the release flight to settle");
      expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId: null });
      expect(isNativeMainTrafficBlocked()).toBe(false);
    } finally {
      recovery.open();
      await within(flight ?? lifecycle.release(), "the release flight to settle");
    }
  });

  test("a release that leaves another reference keeps the live gate closed", async () => {
    const f = fabricatedHome("shared-reference-home");
    const recovery = barrier();
    const recoveryEntered = barrier();
    let recoveryState: NativeProfileRecoveryState = "journal";
    const deps: NativeMainStartupGateDeps = {
      manager: f.manager,
      probeRecoveryState: () => recoveryState,
      beforeRecovery: async () => { recoveryEntered.open(); await recovery.promise; recoveryState = "none"; },
      owner: OWNER,
    };
    const first = startLifecycle(deps);
    const second = startLifecycle(deps);
    try {
      await within(recoveryEntered.promise, "the owned recovery phase to start");

      await first.release();
      // The surviving reference still owns the entry, so nothing was removed and nothing resets.
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: f.homeId,
        reason: "recovery-pending",
      });
      expect(isNativeMainTrafficBlocked()).toBe(true);

      recovery.open();
      expect(await within(second.settled, "the shared convergence to settle")).toEqual({
        status: "ready",
        homeId: f.homeId,
      });
      expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId: f.homeId });
      expect(isNativeMainTrafficBlocked()).toBe(false);
    } finally {
      recovery.open();
      await within(second.release(), "the surviving release to settle");
    }
  });

  test("a successor lifecycle for the same home is not clobbered by the released predecessor", async () => {
    const f = fabricatedHome("successor-home");
    const predecessorRecovery = barrier();
    const predecessorEntered = barrier();
    const successorSweep = barrier();
    const successorSweepEntered = barrier();
    let predecessorState: NativeProfileRecoveryState = "journal";
    const predecessor = startLifecycle({
      manager: f.manager,
      probeRecoveryState: () => predecessorState,
      beforeRecovery: async () => {
        predecessorEntered.open();
        await predecessorRecovery.promise;
        predecessorState = "none";
      },
      owner: OWNER,
    });
    let predecessorFlight: Promise<void> | undefined;
    let successor: NativeMainStartupLifecycle | undefined;
    try {
      await within(predecessorEntered.promise, "the predecessor's recovery phase to start");
      predecessorFlight = predecessor.release();
      expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId: null });

      // A fresh server for the same home arms its own gate while the predecessor's convergence --
      // and its exclusive claim -- is still in flight.
      successor = startLifecycle({
        manager: fabricatedManager(f.context, {
          sweepStages: async () => {
            successorSweepEntered.open();
            await successorSweep.promise;
            return { plaintextMayRemain: false };
          },
        }),
        probeRecoveryState: () => "none",
        owner: OWNER,
      });
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: f.homeId,
        reason: "recovery-pending",
      });

      // The predecessor's late convergence runs to completion here. Its own entry is gone from
      // the map, so neither its success path nor the successor's armed state may move.
      predecessorRecovery.open();
      await within(predecessorFlight, "the predecessor's release flight to settle");
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: f.homeId,
        reason: "recovery-pending",
      });

      await within(successorSweepEntered.promise, "the successor's stage sweep to start");
      successorSweep.open();
      expect(await within(successor.settled, "the successor's convergence to settle")).toEqual({
        status: "ready",
        homeId: f.homeId,
      });
      expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId: f.homeId });
      expect(isNativeMainTrafficBlocked()).toBe(false);
    } finally {
      predecessorRecovery.open();
      successorSweep.open();
      await within(predecessorFlight ?? predecessor.release(), "the predecessor release to settle");
      if (successor) await within(successor.release(), "the successor release to settle");
    }
  });

  test("a release inside the hard-lock claim phase still leaves the gate unblocked", async () => {
    const f = fabricatedHome("hard-lock-claim-phase-home");
    const sweep = barrier();
    const sweepEntered = barrier();
    const claim = barrier();
    const claimEntered = barrier();
    const lifecycle = startLifecycle({
      manager: fabricatedManager(f.context, {
        sweepStages: async () => {
          sweepEntered.open();
          await sweep.promise;
          return { plaintextMayRemain: false };
        },
      }),
      probeRecoveryState: () => "none",
      owner: OWNER,
    });
    let holder: Promise<void> | undefined;
    let flight: Promise<void> | undefined;
    try {
      await within(sweepEntered.promise, "the owned stage sweep to start");

      // Hold the cross-process claim the hard-lock phase takes next, so this convergence parks
      // inside that phase. The sweep is released only once the claim is provably held.
      holder = withNativeMainExclusiveClaim(f.context, async () => {
        claimEntered.open();
        await claim.promise;
      }, { waitMs: 5_000, hardenPath: async () => {} });
      await within(claimEntered.promise, "the held exclusive claim");
      sweep.open();

      // Nothing about the phase can complete while this test owns the claim. If the gate had
      // already reached ready here, the release below would not be landing inside the phase.
      await Bun.sleep(150);
      expect(nativeMainStartupGateSnapshot()).toEqual({
        status: "blocked",
        homeId: f.homeId,
        reason: "recovery-pending",
      });

      flight = lifecycle.release();
      expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId: null });
      expect(isNativeMainTrafficBlocked()).toBe(false);

      // The phase acquires the claim and finds no entry to publish for.
      claim.open();
      await within(holder, "the held claim to be released");
      await within(flight, "the release flight to settle");
      expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId: null });
      expect(isNativeMainTrafficBlocked()).toBe(false);
    } finally {
      sweep.open();
      claim.open();
      await within(holder ?? Promise.resolve(), "the held claim to be released");
      await within(flight ?? lifecycle.release(), "the release flight to settle");
    }
  });
});

