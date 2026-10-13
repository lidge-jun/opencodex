/**
 * A passive management read: it shows what this process already knows and does not make it act on
 * providers, accounts, processes or files (#6959).
 *
 * The Remote Link management relay runs every Child read inside this scope
 * (`src/server/index/link-management.ts`), so a Child can show its Home's state without changing
 * it or making it act. Inside the scope:
 *
 * - model discovery yields no routed models (`fetchAllModels`, the management model rows): it would
 *   reach provider upstreams, refresh Codex entitlements and persist a pending provider's initial
 *   model selection;
 * - provider quota and the Codex account list are served from what the Home has observed, with no
 *   probe, token refresh, native-main claim or publication into routing evidence;
 * - the startup-health diagnostic, the Codex runtime version probes and the bundled-catalog refresh
 *   are not started, so no process runs and no runtime record is written;
 * - a native-main fence raised for unknown service ownership is reported, not re-inspected;
 * - config-directory and credential-file hardening and malformed-file backups are skipped;
 * - memory-budget enforcement demotes only stores registered as `passiveEvictable` (eviction that
 *   only releases memory: the usage caches), never a continuation spill or a replay snapshot.
 *
 * The Home's own dashboard and traffic keep those caches current. A passive read may still join
 * work the Home already started; that work keeps the Home's scope and its writes are the Home's.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const passive = new AsyncLocalStorage<true>();

/** Run a management read passively, including everything it awaits or schedules. */
export function runPassiveRead<T>(run: () => Promise<T>): Promise<T> {
  return passive.run(true, run);
}

export function isPassiveRead(): boolean {
  return passive.getStore() === true;
}
