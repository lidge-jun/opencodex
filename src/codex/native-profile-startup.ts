import { NativeProfileManager } from "./native-profile-manager";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import {
  probeNativeProfileRecoveryState,
  resolveNativeProfileContext,
  type NativeProfileRecoveryState,
} from "./native-profile-store";
import {
  retainNativeMainOwner,
  withNativeMainOwnerOperation,
  type NativeMainOwnerOptions,
  type NativeMainOwnerReference,
  type NativeMainOwnerSnapshot,
} from "./native-main-owner";
import { withNativeMainExclusiveClaim } from "./native-main-claim";
import { scrubNativeMainAuthTempResidues } from "./native-main-auth-temp";
import { NATIVE_STAGE_SWEEP_INTERVAL_MS } from "./native-profile-stage-store";
import type { NativeCodexOwnership } from "../integrations/native/ownership-preflight";

export type NativeMainStartupGateSnapshot =
  | { status: "ready"; homeId: string | null }
  | {
      status: "blocked";
      homeId: string | null;
      reason:
        | "foreign-ownership"
        | "ownership-unknown"
        | "recovery-pending"
        | "manual-recovery"
        | "owner-conflict"
        | "owner-unavailable"
        | "stage-cleanup-required";
    };

/** The settled reason a blocked gate carries, named so consumers can hold one without the union. */
export type NativeMainStartupBlockReason =
  Extract<NativeMainStartupGateSnapshot, { status: "blocked" }>["reason"];

export interface NativeMainStartupGateDeps {
  manager?: NativeProfileManager;
  /** Test-only barrier used to prove admission stays closed while startup recovery is pending. */
  beforeRecovery?: () => void | Promise<void>;
  probeRecoveryState?: typeof probeNativeProfileRecoveryState;
  owner?: NativeMainOwnerOptions;
  stageSweepIntervalMs?: number;
  /** Test seam / activation-time revalidation for the ambient physical auth home. */
  currentHomeId?: () => string | null;
}

export interface NativeMainStartupLifecycle {
  readonly homeId: string | null;
  readonly settled: Promise<NativeMainStartupGateSnapshot>;
  release(): Promise<void>;
}

export interface PreparedNativeMainStartupLifecycle {
  readonly homeId: string;
  start(): NativeMainStartupLifecycle;
}

let epoch = 0;
let snapshot: NativeMainStartupGateSnapshot = { status: "ready", homeId: null };
let settled: Promise<NativeMainStartupGateSnapshot> = Promise.resolve(snapshot);
export type NativeMainServiceOwnershipBlockReason =
  | "foreign-ownership"
  | "ownership-unknown";
const serviceOwnershipRefs = new Map<NativeMainServiceOwnershipBlockReason, number>();
interface StartupEntry {
  homeId: string;
  refs: number;
  epoch: number;
  owner: NativeMainOwnerReference;
  unsubscribe: () => void;
  recoveryStarted: boolean;
  settled: Promise<NativeMainStartupGateSnapshot>;
  resolveAcquisition?: (value: NativeMainStartupGateSnapshot) => void;
  deps: NativeMainStartupGateDeps;
  manager: NativeProfileManager;
  sweepTimer?: ReturnType<typeof setTimeout>;
  sweepInFlight?: Promise<void>;
  sweepStopping: boolean;
}
const startupEntries = new Map<string, StartupEntry>();
const serverLifecycles = new WeakMap<object, NativeMainStartupLifecycle>();
const serverLifecycleReleases = new WeakMap<object, Promise<void>>();

function ready(homeId: string | null): NativeMainStartupGateSnapshot {
  return { status: "ready", homeId };
}

/**
 * Arm the native-main gate synchronously, then converge the encrypted journal in the background.
 * No credential bytes are read here: journal/auth inspection remains inside NativeProfileManager.
 */
export function initializeNativeMainStartupGate(
  deps: NativeMainStartupGateDeps = {},
): Promise<NativeMainStartupGateSnapshot> {
  const currentEpoch = ++epoch;
  let manager: NativeProfileManager;
  try {
    manager = deps.manager ?? new NativeProfileManager();
  } catch {
    // A missing/unresolvable Codex home cannot provide a usable native-main token either.
    // Do not turn an unused opt-in feature into a process-wide startup outage.
    snapshot = ready(null);
    settled = Promise.resolve(snapshot);
    return settled;
  }

  const homeId = manager.context.homeId;
  const probe = deps.probeRecoveryState ?? probeNativeProfileRecoveryState;
  let recoveryState: NativeProfileRecoveryState;
  try {
    recoveryState = probe(manager.context);
  } catch {
    snapshot = { status: "blocked", homeId, reason: "manual-recovery" };
    settled = Promise.resolve(snapshot);
    return settled;
  }
  if (recoveryState === "none") {
    snapshot = ready(homeId);
    settled = Promise.resolve(snapshot);
    return settled;
  }

  if (recoveryState !== "journal") {
    snapshot = { status: "blocked", homeId, reason: "manual-recovery" };
    settled = Promise.resolve(snapshot);
    return settled;
  }

  snapshot = { status: "blocked", homeId, reason: "recovery-pending" };
  settled = (async () => {
    try {
      await deps.beforeRecovery?.();
      await manager.recover(false);
      if (epoch === currentEpoch && probe(manager.context) === "none") {
        clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        snapshot = ready(homeId);
      } else if (epoch === currentEpoch) {
        snapshot = { status: "blocked", homeId, reason: "manual-recovery" };
      }
    } catch {
      if (epoch === currentEpoch) snapshot = { status: "blocked", homeId, reason: "manual-recovery" };
    }
    return snapshot;
  })();
  return settled;
}

function ownerBlockedReason(owner: NativeMainOwnerSnapshot): "owner-conflict" | "owner-unavailable" {
  return owner.status === "unavailable" ? "owner-unavailable" : "owner-conflict";
}

async function runOwnedStageSweep(entry: StartupEntry): Promise<boolean> {
  if (typeof (entry.manager as Partial<NativeProfileManager>).sweepStages !== "function") return true;
  // A fresh installation has no stage registry or staging tree. Avoid creating
  // and contending on the profile transaction database for an inert subsystem.
  // Real managers treat every present or uncertain artifact as sweep-required;
  // partial test/library managers without the preflight keep the old behavior.
  if (
    typeof (entry.manager as Partial<NativeProfileManager>).stageSweepRequired === "function"
    && !entry.manager.stageSweepRequired()
  ) return true;
  try {
    const result = await withNativeMainOwnerOperation(entry.manager.context, () => entry.manager.sweepStages());
    return !result.plaintextMayRemain;
  } catch {
    return false;
  }
}

function scheduleStageSweep(entry: StartupEntry): void {
  if (entry.sweepStopping || entry.sweepTimer || startupEntries.get(entry.homeId) !== entry) return;
  const intervalMs = Math.max(10, entry.deps.stageSweepIntervalMs ?? NATIVE_STAGE_SWEEP_INTERVAL_MS);
  entry.sweepTimer = setTimeout(() => {
    entry.sweepTimer = undefined;
    if (entry.sweepStopping || startupEntries.get(entry.homeId) !== entry) return;
    entry.sweepInFlight = (async () => {
      const safe = await runOwnedStageSweep(entry);
      if (entry.sweepStopping || startupEntries.get(entry.homeId) !== entry) return;
      if (!safe) snapshot = { status: "blocked", homeId: entry.homeId, reason: "stage-cleanup-required" };
      else if (snapshot.homeId === entry.homeId && snapshot.status === "blocked" && snapshot.reason === "stage-cleanup-required") {
        snapshot = ready(entry.homeId);
      }
    })().finally(() => {
      entry.sweepInFlight = undefined;
      scheduleStageSweep(entry);
    });
  }, intervalMs);
  entry.sweepTimer.unref?.();
}

function convergeOwnedStartup(entry: StartupEntry): void {
  if (entry.recoveryStarted) return;
  entry.recoveryStarted = true;
  const currentEpoch = entry.epoch;
  snapshot = { status: "blocked", homeId: entry.homeId, reason: "recovery-pending" };
  const acquisitionWaiter = entry.resolveAcquisition;
  entry.resolveAcquisition = undefined;
  entry.settled = settled = (async () => {
    const probe = entry.deps.probeRecoveryState ?? probeNativeProfileRecoveryState;
    try {
      const recoveryState = await withNativeMainOwnerOperation(entry.manager.context, () => withNativeMainExclusiveClaim(
        entry.manager.context,
        async () => {
          scrubNativeMainAuthTempResidues(entry.manager.context);
          let state = probe(entry.manager.context);
          if (state === "journal") {
            await entry.deps.beforeRecovery?.();
            await entry.manager.recover(false);
            state = probe(entry.manager.context);
          }
          return state;
        },
        { waitMs: 10_000 },
      ));
      const stageSweepSafe = recoveryState === "none" ? await runOwnedStageSweep(entry) : false;
      if (startupEntries.get(entry.homeId) === entry && entry.epoch === currentEpoch && recoveryState === "none" && stageSweepSafe) {
        clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        snapshot = ready(entry.homeId);
      } else if (startupEntries.get(entry.homeId) === entry && entry.epoch === currentEpoch && recoveryState === "none") {
        snapshot = { status: "blocked", homeId: entry.homeId, reason: "stage-cleanup-required" };
      } else if (startupEntries.get(entry.homeId) === entry && entry.epoch === currentEpoch) {
        snapshot = { status: "blocked", homeId: entry.homeId, reason: "manual-recovery" };
      }
    } catch {
      if (startupEntries.get(entry.homeId) === entry && entry.epoch === currentEpoch) {
        snapshot = { status: "blocked", homeId: entry.homeId, reason: "manual-recovery" };
      }
    }
    if (startupEntries.get(entry.homeId) === entry && entry.epoch === currentEpoch) scheduleStageSweep(entry);
    return snapshot;
  })();
  if (acquisitionWaiter) void entry.settled.then(acquisitionWaiter);
}

function observeOwner(entry: StartupEntry, owner: NativeMainOwnerSnapshot): void {
  if (startupEntries.get(entry.homeId) !== entry) return;
  if (owner.status === "acquiring") {
    snapshot = { status: "blocked", homeId: entry.homeId, reason: "recovery-pending" };
    return;
  }
  if (owner.status === "held") {
    convergeOwnedStartup(entry);
    return;
  }
  if (owner.status === "closing" || owner.status === "released") return;
  snapshot = { status: "blocked", homeId: entry.homeId, reason: ownerBlockedReason(owner) };
  entry.settled = settled = Promise.resolve(snapshot);
  entry.resolveAcquisition?.(snapshot);
  entry.resolveAcquisition = undefined;
}

/**
 * Retain process ownership for one live server. The first reference acquires the
 * canonical-home SQLite lease and owns recovery; later same-process references share it.
 */
export function startNativeMainStartupLifecycle(
  deps: NativeMainStartupGateDeps = {},
): NativeMainStartupLifecycle {
  let manager: NativeProfileManager;
  try {
    manager = deps.manager ?? new NativeProfileManager();
  } catch {
    snapshot = ready(null);
    settled = Promise.resolve(snapshot);
    return { homeId: null, settled, release: async () => {} };
  }
  const homeId = manager.context.homeId;
  let entry = startupEntries.get(homeId);
  if (!entry) {
    const owner = retainNativeMainOwner(manager.context, deps.owner);
    snapshot = { status: "blocked", homeId, reason: "recovery-pending" };
    let resolveAcquisition!: (value: NativeMainStartupGateSnapshot) => void;
    const acquisition = new Promise<NativeMainStartupGateSnapshot>(resolve => { resolveAcquisition = resolve; });
    settled = acquisition;
    entry = {
      homeId,
      refs: 0,
      epoch: ++epoch,
      owner,
      unsubscribe: () => {},
      recoveryStarted: false,
      settled: acquisition,
      resolveAcquisition,
      deps,
      manager,
      sweepStopping: false,
    };
    startupEntries.set(homeId, entry);
    entry.unsubscribe = owner.subscribe(ownerState => observeOwner(entry!, ownerState));
  }
  entry.refs += 1;
  let released = false;
  return {
    homeId,
    get settled() { return entry!.settled; },
    async release() {
      if (released) return;
      released = true;
      entry!.refs = Math.max(0, entry!.refs - 1);
      if (entry!.refs !== 0) return;
      entry!.epoch += 1;
      entry!.sweepStopping = true;
      if (entry!.sweepTimer) clearTimeout(entry!.sweepTimer);
      entry!.sweepTimer = undefined;
      entry!.unsubscribe();
      startupEntries.delete(homeId);
      entry!.resolveAcquisition?.(snapshot);
      entry!.resolveAcquisition = undefined;
      // Startup convergence can transition from the exclusive recovery claim
      // into a stage sweep. Keep the owner registered until that entire chain
      // settles so no cleanup transaction starts untracked after owner detach.
      await Promise.allSettled([entry!.settled]);
      if (entry!.sweepInFlight) await Promise.allSettled([entry!.sweepInFlight]);
      await entry!.owner.release();
    },
  };
}

/** Resolve and pin the owned lifecycle target without acquiring ownership or creating artifacts. */
export function prepareNativeMainStartupLifecycle(
  deps: NativeMainStartupGateDeps = {},
  homes?: { codexHome: string; configDir: string },
): PreparedNativeMainStartupLifecycle | null {
  let manager: NativeProfileManager;
  try {
    manager = deps.manager ?? new NativeProfileManager(homes);
    if (homes) {
      const expected = resolveNativeProfileContext(homes);
      if (
        manager.context.homeId !== expected.homeId
        || manager.context.instanceId !== expected.instanceId
      ) return null;
    }
  } catch {
    return null;
  }
  const currentHomeId = deps.currentHomeId ?? (() => {
      try { return resolveNativeProfileContext().homeId; } catch { return null; }
    });
  const pinnedDeps = { ...deps, manager };
  return {
    homeId: manager.context.homeId,
    start: () => {
      if (currentHomeId() !== manager.context.homeId) {
        throw new Error("The native-main startup home changed after ownership inspection.");
      }
      return startNativeMainStartupLifecycle(pinnedDeps);
    },
  };
}

/**
 * How many times a service-ownership fence will re-ask before it stops asking (#2108).
 *
 * A host that is permanently unaskable must not re-probe on every request forever, and a
 * host that recovers usually does so within the first few. The budget belongs to the
 * live hook owner, not to an individual fence: raising a second fence deliberately does
 * not hand out a fresh allowance, or a caller looping over fences could spin the probe
 * forever. Spending or releasing that hook owner ends its budget generation; a later
 * fence can install a new owner even if an older hookless fence is still draining.
 */
export const NATIVE_MAIN_OWNERSHIP_RETRY_LIMIT = 5;

/** Reprobe hooks for the fences currently held, keyed by the reason they were raised for. */
const serviceOwnershipReprobes = new Map<NativeMainServiceOwnershipBlockReason, ServiceOwnershipReprobe>();

interface ServiceOwnershipReprobe {
  readonly probe: () => NativeCodexOwnership;
  readonly expectedHomeId: () => string | null;
  readonly activate: () => NativeMainStartupLifecycle;
  readonly adopt: (lifecycle: NativeMainStartupLifecycle) => boolean;
  readonly discard: (lifecycle: NativeMainStartupLifecycle) => void;
  activating: boolean;
  attempts: number;
  /** The fence that installed this hook; only its own release may drop the entry. */
  readonly owner: NativeMainStartupLifecycle;
  /** Releases the fence that installed this hook, exactly once. */
  readonly spend: () => void;
}

function releaseUnadoptedLifecycle(lifecycle: NativeMainStartupLifecycle): Promise<void> {
  try { return Promise.resolve(lifecycle.release()).catch(() => {}); } catch { return Promise.resolve(); }
}

/** Test-only: the retry budget is module state and would otherwise leak across tests. */
export function __resetNativeMainOwnershipRetries(): void {
  for (const entry of serviceOwnershipReprobes.values()) entry.attempts = 0;
}

/**
 * Re-ask whether this host is still unownable, and drop the fence if it is not.
 *
 * `startServer` takes the ownership verdict once, at boot, and holds it for the process
 * lifetime. For `foreign-ownership` that is correct — a foreign owner is a fact, and
 * re-asking would only hand a determined caller a second chance. For `ownership-unknown`
 * it is wrong: that verdict means the probe could not answer, so waiting cannot help,
 * which is precisely why the #2108 reporter had to run `ocx restart` after every reboot.
 *
 * The re-probe is demand-driven rather than timed: it runs when something asks whether
 * native-main is fenced, which is usually a request but is also the background token
 * guardian's warmup. It is capped so a permanently unaskable host cannot spin.
 *
 * The probe is synchronous `spawnSync` with a bounded timeout, and this function is on a
 * request path, so the cap is what keeps a wedged host from paying that cost repeatedly.
 */
function reprobeServiceOwnership(reason: NativeMainServiceOwnershipBlockReason): boolean {
  if (reason !== "ownership-unknown") return false;
  const entry = serviceOwnershipReprobes.get(reason);
  if (!entry) return false;
  if (entry.activating) return false;
  if (entry.attempts >= NATIVE_MAIN_OWNERSHIP_RETRY_LIMIT) return false;
  entry.attempts += 1;
  let activated: NativeMainStartupLifecycle | undefined;
  let expectedHomeId: string | null = null;
  entry.activating = true;
  try {
    const answer = entry.probe();
    if (answer !== "owned") return false;
    expectedHomeId = entry.expectedHomeId();
    if (expectedHomeId === null) return false;
    // Ownership becoming knowable is not itself startup completion. Install the
    // normal owner/recovery lifecycle while this fence is still held, so native
    // traffic cannot get ahead of owner registration, journal recovery, auth-temp
    // scrubbing, or the initial stage sweep.
    activated = entry.activate();
  } catch {
    // Neither a failed inspection nor a failed activation is evidence that
    // native-main is safe to admit. Keep the fence and retry hook intact.
    return false;
  } finally {
    entry.activating = false;
  }
  if (
    !activated
    || activated.homeId === null
    || activated.homeId !== expectedHomeId
    || typeof activated.release !== "function"
  ) {
    if (activated && typeof activated.release === "function") entry.discard(activated);
    return false;
  }
  if (serviceOwnershipReprobes.get(reason) !== entry || !entry.adopt(activated)) {
    // Shutdown or a re-entrant release can retire this fence while activation
    // runs. A lifecycle that was never attached to the server must not retain
    // another owner reference in the background.
    entry.discard(activated);
    return false;
  }
  // Release through the fence that installed this hook, and only that one.
  //
  // Several servers can hold a fence for the same reason while only one carries a hook, so
  // clearing the shared refcount here would unblock fences this probe never spoke for.
  // Decrementing here directly is just as wrong the other way: that fence's own release()
  // would then pay a second time for one fence, leaving the count short. The
  // fence's idempotent spend hook keeps exactly one payment per fence while the
  // transitioned owned lifecycle remains attached until server shutdown.
  entry.spend();
  return true;
}

function activeServiceOwnershipBlockReason(): NativeMainServiceOwnershipBlockReason | null {
  if ((serviceOwnershipRefs.get("foreign-ownership") ?? 0) > 0) return "foreign-ownership";
  if ((serviceOwnershipRefs.get("ownership-unknown") ?? 0) > 0) return "ownership-unknown";
  return null;
}

function serviceOwnershipSnapshot(
  reason: NativeMainServiceOwnershipBlockReason,
): NativeMainStartupGateSnapshot {
  return { status: "blocked", homeId: null, reason };
}

/** Close native-main admission without resolving or creating any CODEX_HOME artifacts. */
export function blockNativeMainStartupForUnownedServiceHome(
  reason: NativeMainServiceOwnershipBlockReason,
  options?: {
    reprobe: () => NativeCodexOwnership;
    expectedHomeId: string | (() => string | null);
    startOwnedLifecycle: () => NativeMainStartupLifecycle;
  },
): NativeMainStartupLifecycle {
  serviceOwnershipRefs.set(reason, (serviceOwnershipRefs.get(reason) ?? 0) + 1);
  let fenceSpent = false;
  let ownedLifecycle: NativeMainStartupLifecycle | undefined;
  let releaseFlight: Promise<void> | undefined;
  const orphanReleaseFlights = new Set<Promise<void>>();
  let lifecycle!: NativeMainStartupLifecycle;
  const blockedSettled = Promise.resolve(serviceOwnershipSnapshot(reason));
  const spendFence = () => {
    if (fenceSpent) return;
    fenceSpent = true;
    const remaining = Math.max(0, (serviceOwnershipRefs.get(reason) ?? 0) - 1);
    if (remaining === 0) serviceOwnershipRefs.delete(reason);
    else serviceOwnershipRefs.set(reason, remaining);
    if (serviceOwnershipReprobes.get(reason)?.owner === lifecycle) {
      serviceOwnershipReprobes.delete(reason);
    }
  };
  lifecycle = {
    get homeId() { return ownedLifecycle?.homeId ?? null; },
    get settled() { return ownedLifecycle?.settled ?? blockedSettled; },
    release() {
      return releaseFlight ??= (async () => {
        spendFence();
        // A synchronous activator can re-enter release before its returned
        // lifecycle is adopted or discarded. Let that call stack finish so the
        // cleanup set is complete before this shared release flight drains it.
        await Promise.resolve();
        await ownedLifecycle?.release();
        if (orphanReleaseFlights.size > 0) {
          await Promise.allSettled([...orphanReleaseFlights]);
        }
      })();
    },
  };
  // Do NOT reset an existing budget: keying the reprobe by reason means a caller raising
  // fences in a loop would otherwise be handed a fresh allowance each time and could spin
  // the probe forever. But once the holder is gone its entry is removed above, so a LATER
  // fence installs its own hook — a server started after an earlier probe must not be left
  // needing `ocx restart`, which is the very symptom this exists to remove.
  if (options && reason === "ownership-unknown" && !serviceOwnershipReprobes.has(reason)) {
    const expectedHomeId = options.expectedHomeId;
    serviceOwnershipReprobes.set(reason, {
      probe: options.reprobe,
      expectedHomeId: typeof expectedHomeId === "function"
        ? expectedHomeId
        : () => expectedHomeId,
      activate: options.startOwnedLifecycle,
      adopt: activated => {
        if (releaseFlight !== undefined || fenceSpent || ownedLifecycle !== undefined) return false;
        ownedLifecycle = activated;
        return true;
      },
      discard: activated => {
        const flight = releaseUnadoptedLifecycle(activated);
        orphanReleaseFlights.add(flight);
        void flight.finally(() => orphanReleaseFlights.delete(flight));
      },
      activating: false,
      attempts: 0,
      owner: lifecycle,
      spend: spendFence,
    });
  }
  return lifecycle;
}

export function bindNativeMainStartupLifecycle(server: object, lifecycle: NativeMainStartupLifecycle): void {
  serverLifecycles.set(server, lifecycle);
}

export async function releaseNativeMainStartupLifecycle(server: object): Promise<void> {
  const existing = serverLifecycleReleases.get(server);
  if (existing) return existing;
  const lifecycle = serverLifecycles.get(server);
  if (!lifecycle) return;
  const flight = Promise.resolve().then(() => lifecycle.release());
  serverLifecycleReleases.set(server, flight);
  try {
    await flight;
  } finally {
    if (serverLifecycleReleases.get(server) === flight) {
      serverLifecycleReleases.delete(server);
      serverLifecycles.delete(server);
    }
  }
}

export function isNativeMainTrafficBlocked(): boolean {
  const reason = activeServiceOwnershipBlockReason();
  if (reason !== null && reprobeServiceOwnership(reason)) {
    // The host became ownable after boot (#2108): the fence lifts here rather than
    // waiting for the restart the reporter had to perform by hand.
    return activeServiceOwnershipBlockReason() !== null || snapshot.status === "blocked";
  }
  return reason !== null || snapshot.status === "blocked";
}

/**
 * Close the process-wide native-main admission gate after a live transaction
 * leaves recovery state behind. A known different home owns a different
 * native credential file, so it must not be fenced by this transition.
 */
export function blockNativeMainRecovery(
  homeId: string,
  recoveryState?: Exclude<NativeProfileRecoveryState, "none">,
): boolean {
  if (snapshot.homeId !== null && snapshot.homeId !== homeId) return false;
  epoch += 1;
  snapshot = {
    status: "blocked",
    homeId,
    reason: recoveryState === "journal" ? "recovery-pending" : "manual-recovery",
  };
  settled = Promise.resolve(snapshot);
  return true;
}

export function completeNativeMainRecovery(homeId: string): boolean {
  if (snapshot.status !== "blocked" || snapshot.homeId !== homeId) return false;
  epoch += 1;
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  snapshot = ready(homeId);
  settled = Promise.resolve(snapshot);
  return true;
}

export function nativeMainStartupGateSnapshot(): NativeMainStartupGateSnapshot {
  const reason = activeServiceOwnershipBlockReason();
  if (reason) return serviceOwnershipSnapshot(reason);
  return { ...snapshot };
}

export function waitForNativeMainStartupGate(): Promise<NativeMainStartupGateSnapshot> {
  const reason = activeServiceOwnershipBlockReason();
  if (reason) return Promise.resolve(serviceOwnershipSnapshot(reason));
  return settled;
}
