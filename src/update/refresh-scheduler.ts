import { checkForUpdate, type UpdateCheckResult } from "./job";
import { currentVersion, defaultUpdateTag, detectInstall, detectInstallOwnership, miseUpdateCommand, type Channel, type Installer } from "./index";
import { isSourceBuildVersion, readVersionCache, REFRESH_INTERVAL_MS, writeFreshVersionCache } from "./notify";
import { latestVersionAsync } from "./async-check";

export const STALENESS_TICK_MS = 60 * 60 * 1000;
export const RETRY_BASE_MS = 60_000;
export const RETRY_CAP_MS = STALENESS_TICK_MS;

export interface RefreshDeps {
  now: () => number;
  lookup: (channel: Channel, installer: Installer) => Promise<string | null>;
  current: () => string;
  install: () => Installer;
  ownership: typeof detectInstallOwnership;
  guidance: typeof miseUpdateCommand;
  read: typeof readVersionCache;
  write: typeof writeFreshVersionCache;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  disabled: () => boolean;
}

const defaults: RefreshDeps = {
  now: Date.now,
  lookup: latestVersionAsync,
  current: currentVersion,
  install: detectInstall,
  ownership: detectInstallOwnership,
  guidance: miseUpdateCommand,
  read: readVersionCache,
  write: writeFreshVersionCache,
  setTimer: setTimeout,
  clearTimer: clearTimeout,
  disabled: () => process.env.OCX_DISABLE_UPDATE_CHECK === "1",
};

export function createRefreshScheduler(deps: RefreshDeps = defaults) {
  const inFlight = new Map<Channel, { task: Promise<string | null>; epoch: number; markExplicit: () => void }>();
  // Flight order per channel: a flight started earlier never overwrites a cache entry that a
  // later-started flight already wrote (an explicit caller can keep an old flight writable
  // across stop/start while the new listener's flight finishes first).
  const lastWrittenFlight = new Map<Channel, number>();
  let flightSeq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let starts = 0;
  let failures = 0;
  let retryAt = 0;
  let generation = 0;

  const eligible = () => {
    const version = deps.current();
    const installer = deps.install();
    return !deps.disabled() && version !== "?" && !isSourceBuildVersion(version)
      && installer !== "source" && installer !== "mise";
  };
  const channel = () => defaultUpdateTag(deps.current());
  const stale = (tag: Channel) => {
    const checked = Date.parse(deps.read(tag)?.last_checked_at ?? "");
    return !Number.isFinite(checked) || checked > deps.now() || deps.now() - checked >= REFRESH_INTERVAL_MS;
  };
  const schedule = (delay: number) => {
    if (!running) return;
    if (timer) deps.clearTimer(timer);
    timer = deps.setTimer(() => { timer = undefined; void tick(); }, delay);
    timer.unref?.();
  };
  const lookup = (tag: Channel, automatic: boolean): Promise<string | null> => {
    const existing = inFlight.get(tag);
    // An automatic tick joins only a flight of its own generation. A flight left over from a
    // stopped listener cannot write for the new one, so joining it would push the next check an
    // hour out with nothing written. Explicit callers may join any flight: their interest writes.
    if (existing && (!automatic || existing.epoch === generation)) {
      if (!automatic) existing.markExplicit();
      return existing.task;
    }
    const epoch = generation;
    const seq = ++flightSeq;
    let explicitInterest = !automatic;
    const task = Promise.resolve().then(() => deps.lookup(tag, deps.install())).then(latest => {
      if (latest && (explicitInterest || (automatic && running && epoch === generation))
        && seq > (lastWrittenFlight.get(tag) ?? 0)) {
        lastWrittenFlight.set(tag, seq);
        deps.write(tag, latest, deps.now());
      }
      if (automatic && running && epoch === generation) {
        failures = latest ? 0 : failures + 1;
        retryAt = latest ? 0 : deps.now() + Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 6));
      }
      return latest;
    }).catch(() => {
      if (automatic && running && epoch === generation) {
        failures += 1;
        retryAt = deps.now() + Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 6));
      }
      return null;
    }).finally(() => { if (inFlight.get(tag)?.task === task) inFlight.delete(tag); });
    inFlight.set(tag, { task, epoch, markExplicit: () => { explicitInterest = true; } });
    return task;
  };
  const tick = async () => {
    if (!running || !eligible()) return;
    const tag = channel();
    if (stale(tag) && deps.now() >= retryAt) await lookup(tag, true);
    schedule(retryAt > deps.now() ? Math.min(STALENESS_TICK_MS, retryAt - deps.now()) : STALENESS_TICK_MS);
  };
  return {
    start() {
      starts += 1;
      if (starts !== 1 || !eligible()) return;
      running = true;
      schedule(0);
    },
    stop() {
      if (starts === 0) return;
      starts -= 1;
      if (starts !== 0) return;
      running = false;
      generation += 1;
      if (timer) deps.clearTimer(timer);
      timer = undefined;
    },
    async check(tag: Channel): Promise<UpdateCheckResult> {
      const installer = deps.install();
      const latest = installer === "source" || installer === "mise" ? null : await lookup(tag, false);
      return checkForUpdate(tag, {
        currentVersion: deps.current,
        detectInstall: deps.install,
        detectInstallOwnership: deps.ownership,
        miseUpdateCommand: deps.guidance,
        latestVersion: () => latest,
      });
    },
  };
}

export const packageRefresh = createRefreshScheduler();

export function startPackageRefresh(): void { packageRefresh.start(); }
export function stopPackageRefresh(): void { packageRefresh.stop(); }
