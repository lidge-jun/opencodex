import { readLinkStore } from "./store";
import { childObservationsPath, linkKnownHostsPath, linkStorePath } from "./paths";
import { createSshRunner, type SshRunner } from "./ssh-runner";
import { projectLinkStatus } from "./status-projection";
import type { LinkTunnelStatus } from "./supervisor";
import { sharedChildOpsEngine } from "./child-ops-engine";
import type { ChildOpsEnv } from "./child-ops-types";
import { createChildOpsScheduler, type ChildOpsScheduler } from "./child-ops-scheduler";
import { readChildPolicy } from "./child-policy";
import type { CatalogRevisionMonitor } from "./child-catalog-freshness";
import { isLinkIdle, type LinkActivitySnapshot } from "./child-activity";
import { observeChild, type ObserveDeps } from "./child-observe";
import { inspectRemoteChildRuntime } from "./remote-plant";
import { requireRemotePlatform } from "./remote-platform";
import { patchChildObservation, readChildObservations, updateChildObservations } from "./child-observations";
import { homeLinkChildParity, type LinkChildParity } from "./child-parity";
import { codexSettingsDigest, projectHomeCodexSettings } from "./codex-settings";
import { packageVersion } from "../lib/package-version";
import { setCatalogAutoRefreshLinkFanout } from "../codex/catalog-auto-refresh";
import type { OcxConfig } from "../types";

/**
 * The running Home's Child-ops host (050): builds the engine env and the catalog fan-out scheduler. Loaded only by a
 * dynamic import from optional-listeners.ts once the link listener owns its socket (INV-LINK-CHILD-OPS-01).
 */
export interface ChildOpsHostBinding {
  config: () => OcxConfig;
  supervisorStatus: () => readonly LinkTunnelStatus[];
  listenerStatus: () => { state: "off" | "listening" | "failed"; port: number | null };
  /** 020's listener linkActivity; null when the listener has no activity book (never idle). */
  activity: (linkId: string, now: number) => LinkActivitySnapshot | null;
  /** 020's catalogRevisionForRoutes() singleton, handed over by optional-listeners (src/link cannot import it). */
  catalogRevision: () => CatalogRevisionMonitor;
  /** 020's listener peerObservation. */
  peer: ObserveDeps["peer"];
}

/** The scheduler's revision view over 020's monitor: recompute() is true when the etag moved since it last looked. */
export function schedulerRevision(monitor: CatalogRevisionMonitor) {
  let seen: string | null | undefined;
  return {
    current: (): { etag: string | null; changedAt: number | null } => {
      const revision = monitor.current();
      return revision ? { etag: revision.etag, changedAt: revision.changedAt } : { etag: null, changedAt: null };
    },
    async recompute(): Promise<boolean> {
      const etag = monitor.current()?.etag ?? null;
      const changed = seen !== undefined && etag !== seen;
      seen = etag;
      return changed;
    },
  };
}

/** Revision 4 (4529521968): the etag a Home-run sync last delivered; a GET of /v1/catalog never sets it. */
export function syncedEtagFor(linkId: string): string | null {
  return readChildObservations(childObservationsPath()).children[linkId]?.catalogSyncedEtag ?? null;
}

/**
 * The Child's applied settings digest, only while its runtime started at or after that apply (#8557 review). A sync on a
 * Child whose runtime predates its last apply restarts that runtime even when the settings did not change
 * (restartRuntimeAfterApply), which would cut a busy Child's relayed streams. Both times are the Child's own clock.
 */
export function runtimeCurrentDigest(parity: LinkChildParity): string | null {
  const { appliedCodexSettingsDigest: digest, lastApplyAt, runtimeStartedAt } = parity;
  return digest !== null && lastApplyAt !== null && runtimeStartedAt !== null && runtimeStartedAt >= lastApplyAt ? digest : null;
}

const errorName = (error: unknown): string => error instanceof Error ? error.name : "unknown";

/**
 * One env shape for the routes (030 childOpsEnvFor) and this host; idleAfterMs is the policy value. Revision 4
 * (4529522063): with digests, autoSyncAllowed is the scheduler's own rule (idle, or settings already equal), asked
 * again by runSyncItem when each automatic item starts.
 */
export function hostChildOpsEnv(binding: ChildOpsHostBinding, runner: Pick<SshRunner, "run">,
  digests?: { home: () => string | null; child: (linkId: string) => string | null }): ChildOpsEnv {
  const store = () => readLinkStore(linkStorePath());
  const hosts = linkKnownHostsPath();
  const version = packageVersion("0.0.0");
  // Read on every check, not captured: the scheduler reuses one env across sync groups, and a policy change between
  // them must apply to the next idle decision (#8557 review).
  const idleAfterMs = (): number => readChildPolicy().policy.idleAfterMs;
  const env: ChildOpsEnv = {
    readStore: store, runner, knownHostsFile: hosts, homeVersion: version, now: Date.now, sleep: ms => Bun.sleep(ms),
    // projectLinkStatus's default compensation read; the route state's in-memory compensationFailures are not visible
    // here, and such a link is mid-removal: its item fails or reports offline, which the backoff absorbs.
    wireState: linkId => projectLinkStatus(store(), binding.supervisorStatus(), binding.listenerStatus(), binding.config())
      .links.find(link => link.id === linkId)?.state ?? null,
    activity: linkId => {
      const now = Date.now();
      const snapshot = binding.activity(linkId, now);
      return snapshot ? { inFlight: snapshot.inFlight, idle: isLinkIdle(snapshot, now, idleAfterMs()) } : null;
    },
    observe: record => observeChild(record, { runner, knownHostsFile: hosts, homeVersion: version, peer: binding.peer,
      platformOf: link => requireRemotePlatform(runner, link.alias, link.explicitRoute ?? null, hosts), inspect: inspectRemoteChildRuntime,
      now: () => new Date() }),
    readObservation: linkId => readChildObservations(childObservationsPath()).children[linkId] ?? null,
    // ChildOpsEnv contract: never throws (child-ops-types.ts); same shape as childOpsEnvFor.
    writeObservation: (linkId, patch) => {
      try { updateChildObservations(file => patchChildObservation(file, linkId, patch, new Date())); }
      catch (error) { console.warn(`[link] child observation write failed linkId=${linkId} error=${errorName(error)}`); }
    },
    catalogEtag: () => { try { return binding.catalogRevision().current()?.etag ?? null; } catch { return null; } },
  };
  if (digests) env.autoSyncAllowed = linkId => {
    if (env.activity(linkId)?.idle === true) return true;
    const home = digests.home();
    return home !== null && digests.child(linkId) === home;
  };
  return env;
}

/** Starts the scheduler and returns its stop. wp5 sets no afterPoll: no update job starts here (070 adds the sweep). */
export function startChildOpsHost(binding: ChildOpsHostBinding): () => void {
  const runner = createSshRunner();
  const version = packageVersion("0.0.0");
  const unref = <T>(handle: T): T => { (handle as { unref?: () => void }).unref?.(); return handle; };
  const homeDigest = (): string | null => {
    try { return codexSettingsDigest(projectHomeCodexSettings(binding.config(), version).settings); } catch { return null; }
  };
  const childDigest = (linkId: string): string | null => runtimeCurrentDigest(homeLinkChildParity.get(linkId));
  const scheduler: ChildOpsScheduler = createChildOpsScheduler({
    engine: sharedChildOpsEngine(), env: () => hostChildOpsEnv(binding, runner, { home: homeDigest, child: childDigest }),
    readPolicy: () => readChildPolicy(),
    revision: schedulerRevision(binding.catalogRevision()),
    syncedEtag: syncedEtagFor,
    homeDigest, childDigest,
    peerVersion: linkId => binding.peer(linkId).observed?.version ?? null,
    isClientRuntime: () => binding.config().runtimeRole === "client",
    setCatalogChangedSlot: setCatalogAutoRefreshLinkFanout,
    setTimeout: (fn, ms) => unref(setTimeout(fn, ms)), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => unref(setInterval(fn, ms)), clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
  });
  scheduler.start();
  return () => scheduler.stop();
}
