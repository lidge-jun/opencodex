import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRealBunBinary } from "./bun-binary-validator.mjs";
import { isStandaloneBinary } from "./standalone";

export interface PackageTreeObservation {
  readonly device: bigint;
  readonly inode: bigint;
  readonly contentTimeNs: bigint;
  readonly size: bigint;
}

export type PackageTreeIntegrityStatus =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "package_tree_replaced" | "package_tree_unreadable" };

export interface PackageTreeIntegrityGuard {
  status(): PackageTreeIntegrityStatus;
  /**
   * Version recorded in the package manifest that is on disk NOW, once the replacement has
   * settled. A fenced proxy reports it so `ocx restart` compares the CLI with the files an
   * in-place respawn would run, not with the version this process booted from.
   *
   * A readable manifest is not an install-completion signal: npm can write package.json while
   * it is still extracting the rest of the tree. So this stays undefined until the guard's own
   * stability debounce has seen the same replacement identity for the full interval, and again
   * whenever the tree has moved since. Undefined also covers an unreadable or malformed manifest.
   */
  installedVersion?(): string | undefined;
  /**
   * Permanently disarms the guard: cancels any pending restart timer and
   * invalidates queued callbacks. Called from `server.stop()` so a still-queued
   * replacement callback cannot schedule a drain-and-restart after shutdown
   * has already begun.
   */
  dispose(): void;
}

export interface PackageTreeIntegrityOptions {
  /**
   * Called once when a replaced package tree persists past `replacedRestartDelayMs`
   * of sustained failure. The intended handler is the graceful drain-and-restart
   * acceptor: an out-of-band install (npm/bun/pnpm global upgrade under a live
   * proxy) then self-heals instead of serving 503s until someone restarts by hand.
   * Only `package_tree_replaced` counts — an unreadable manifest resets the timer,
   * so an install still mid-write does not trigger a restart on partial state.
   */
  onReplaced?: () => void;
  /** Sustained-replacement delay before `onReplaced` fires. 0 fires on first detection. */
  replacedRestartDelayMs?: number;
  /**
   * Test seam; production uses an unref'd timer. May return a cancellation
   * function; when it does, `resetRestartTimer` cancels the pending callback
   * instead of leaving it queued behind a generation check.
   */
  schedule?: (callback: () => void, delayMs: number) => (() => void) | void;
  /** Test seam for `installedVersion()`; production reads the package manifest. */
  readInstalledVersion?: () => string | undefined;
  /**
   * Whether the runtime a restart would spawn is complete. An in-place npm install writes
   * package.json and extracts the `bun` package's small placeholder before its postinstall
   * swaps the real binary in, and the replacement spawns `process.execPath`, that same path.
   * While this answers false the replacement is treated like an unreadable tree: no restart,
   * then a fresh full debounce once the runtime is ready.
   */
  runtimeReady?: () => boolean;
}

export type ObservePackageTree = () => PackageTreeObservation | null;
export type PackageTreeRuntimeInstall = "bun" | "mise" | "npm" | "pnpm" | "source";

const packageManifestUrl = new URL("../../package.json", import.meta.url);

const INSTALLED_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Directory of the package this process was loaded from, as the module loader spells it. */
export function runningPackageRoot(): string {
  return dirname(fileURLToPath(packageManifestUrl));
}

function readInstalledManifestVersion(): string | undefined {
  return readPackageManifestVersionAt(fileURLToPath(packageManifestUrl));
}

/** The `version` of the manifest at `manifestPath`, or undefined when unreadable or malformed. */
export function readPackageManifestVersionAt(manifestPath: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" && version.length <= 64 && INSTALLED_VERSION_PATTERN.test(version)
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

function observePackageManifest(): PackageTreeObservation | null {
  return observePackageManifestAt(fileURLToPath(packageManifestUrl));
}

/** Identity of the manifest at `manifestPath`, or null when it cannot be stat'd. */
export function observePackageManifestAt(manifestPath: string): PackageTreeObservation | null {
  try {
    const stat = statSync(manifestPath, { bigint: true });
    return {
      device: stat.dev,
      inode: stat.ino,
      // mtimeNs, NOT ctimeNs. An inode-change time moves for METADATA writes that
      // replace nothing: chmod, chown, touch, an editor normalizing permissions, a
      // backup tool restoring modes. Each of those left device, inode and size
      // identical, so the comparison below called the manifest "replaced" and every
      // /v1/* request answered 503 until the process was restarted. Measured on
      // macOS: chmod alone moved ctimeNs and left mtimeNs untouched.
      //
      // mtimeNs still catches every real replacement. An in-place rewrite of the
      // same byte length moves mtimeNs while inode and size hold; an atomic
      // install (write-then-rename, which is what a package manager does) changes
      // the inode as well. Both were measured before this change was made.
      contentTimeNs: stat.mtimeNs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

/** The manifest path inside a package root. */
export function packageManifestPathIn(root: string): string {
  return join(root, "package.json");
}

export function sameObservation(left: PackageTreeObservation, right: PackageTreeObservation): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.contentTimeNs === right.contentTimeNs
    && left.size === right.size;
}

/**
 * How long an `ok` observation is reused before the manifest is stat'd again.
 *
 * `status()` runs on `/healthz`, `/readyz` and every `/v1/*` request, so an unthrottled guard
 * adds a filesystem syscall to the proxy's hot path to detect an event that happens at most
 * once per install. A replaced tree is not time-critical either: the process is already
 * serving broken imports, and one more second of that is not worse than a syscall per turn
 * forever.
 *
 * A NEGATIVE result is never cached — once the tree looks wrong, every later request re-checks,
 * so a repaired install recovers on its own instead of staying refused for a window.
 */
const PACKAGE_TREE_RECHECK_MS = 1_000;

/**
 * Fences a live process whose package manifest was replaced, and once the replacement is readable,
 * stable for the debounce interval and any configured `runtimeReady` check passes, hands it to
 * `onReplaced`. If the callback throws, the guard rechecks the tree and may call it again after
 * another debounce interval while the replacement persists.
 */
export function createPackageTreeIntegrityGuard(
  observe: ObservePackageTree = observePackageManifest,
  now: () => number = Date.now,
  options: PackageTreeIntegrityOptions = {},
): PackageTreeIntegrityGuard {
  const boot = observe();
  let lastOkAt: number | null = null;
  let notified = false;
  let timerGeneration = 0;
  let timerScheduled = false;
  let cancelScheduled: (() => void) | null = null;
  let waitingForReadableTree = false;
  /** Logged once per wait, so a postinstall that never runs is visible rather than silent. */
  let waitingForRuntime = false;
  let replacementCandidate: PackageTreeObservation | null = null;
  /** The replacement identity that survived a full stability interval (see installedVersion). */
  let settledReplacement: PackageTreeObservation | null = null;
  const restartDelayMs = options.replacedRestartDelayMs ?? 5_000;
  const readInstalledVersion = options.readInstalledVersion ?? readInstalledManifestVersion;
  const schedule = options.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  });

  const resetRestartTimer = (): void => {
    timerGeneration += 1;
    timerScheduled = false;
    const cancel = cancelScheduled;
    cancelScheduled = null;
    cancel?.();
  };

  const armRestartTimer = (delayMs = restartDelayMs): void => {
    if (!options.onReplaced || notified || timerScheduled) return;
    timerScheduled = true;
    const generation = timerGeneration;
    const verifyAndNotify = () => {
      if (generation !== timerGeneration || notified) return;
      timerScheduled = false;
      const current = observe();
      if (boot === null || current === null) {
        // A package manager may replace package.json before the rest of the tree.
        // Wait for a readable tree, then require a fresh full debounce interval.
        resetRestartTimer();
        waitingForReadableTree = true;
        armRestartTimer(PACKAGE_TREE_RECHECK_MS);
        return;
      }
      if (sameObservation(boot, current)) {
        resetRestartTimer();
        waitingForReadableTree = false;
        waitingForRuntime = false;
        replacementCandidate = null;
        return;
      }
      if (options.runtimeReady && !options.runtimeReady()) {
        if (!waitingForRuntime) {
          waitingForRuntime = true;
          console.warn("Package tree replaced; waiting for its Bun runtime to finish installing before restarting");
        }
        // A replacement settled before a failed admission is no longer restart-ready: withdraw
        // it so installedVersion() stays silent until the fresh debounce settles it again.
        settledReplacement = null;
        resetRestartTimer();
        waitingForReadableTree = true;
        armRestartTimer(PACKAGE_TREE_RECHECK_MS);
        return;
      }
      waitingForRuntime = false;
      if (waitingForReadableTree) {
        waitingForReadableTree = false;
        replacementCandidate = current;
        resetRestartTimer();
        armRestartTimer();
        return;
      }
      if (replacementCandidate === null || !sameObservation(replacementCandidate, current)) {
        replacementCandidate = current;
        resetRestartTimer();
        armRestartTimer();
        return;
      }
      settledReplacement = current;
      try {
        options.onReplaced?.();
        notified = true;
      } catch {
        // A failed restart admission must not leave the proxy fenced forever.
        // Re-observe after the normal debounce and try again if replacement persists.
        armRestartTimer(Math.max(PACKAGE_TREE_RECHECK_MS, restartDelayMs));
      }
    };
    if (delayMs === 0) {
      // Defer like the scheduled path: verifyAndNotify can arm the next timer, and a
      // synchronous verify inside this frame would re-enter armRestartTimer while this
      // arm is still running.
      queueMicrotask(verifyAndNotify);
    } else {
      // The seam may run the callback synchronously; defer the work so
      // cancelScheduled ownership is settled before verifyAndNotify can
      // re-enter armRestartTimer.
      const cancel = schedule(() => {
        queueMicrotask(verifyAndNotify);
      }, delayMs);
      if (generation === timerGeneration && timerScheduled && typeof cancel === "function") {
        cancelScheduled = cancel;
      }
    }
  };

  return {
    installedVersion: () => {
      if (settledReplacement === null) return undefined;
      if (options.runtimeReady && !options.runtimeReady()) return undefined;
      const current = observe();
      if (current === null || !sameObservation(settledReplacement, current)) return undefined;
      return readInstalledVersion();
    },
    dispose(): void {
      resetRestartTimer();
      notified = true;
    },
    status(): PackageTreeIntegrityStatus {
      const at = now();
      if (lastOkAt !== null && at - lastOkAt < PACKAGE_TREE_RECHECK_MS) return { ok: true };
      const current = observe();
      if (boot === null || current === null) {
        const wasWatchingReplacement = timerScheduled;
        resetRestartTimer();
        if (wasWatchingReplacement && boot !== null) {
          waitingForReadableTree = true;
          armRestartTimer(PACKAGE_TREE_RECHECK_MS);
        }
        return { ok: false, reason: "package_tree_unreadable" };
      }
      if (!sameObservation(boot, current)) {
        if (replacementCandidate === null || !sameObservation(replacementCandidate, current)) {
          replacementCandidate = current;
          resetRestartTimer();
        }
        armRestartTimer();
        return { ok: false, reason: "package_tree_replaced" };
      }
      lastOkAt = at;
      resetRestartTimer();
      waitingForReadableTree = false;
      waitingForRuntime = false;
      replacementCandidate = null;
      return { ok: true };
    },
  };
}

/**
 * Installed packages fail closed when their manifest is replaced under a live process.
 * A source checkout is different: editing package.json is ordinary development work, and
 * Bun keeps serving the module snapshot already loaded by this process until the operator
 * chooses to restart. Fencing every request there makes running dev directly impossible.
 */
export function createRuntimePackageTreeIntegrityGuard(
  installer: PackageTreeRuntimeInstall,
  observe: ObservePackageTree = observePackageManifest,
  now: () => number = Date.now,
  options: PackageTreeIntegrityOptions = {},
  ): PackageTreeIntegrityGuard {
    if (installer === "source" || isStandaloneBinary()) {
      return { status: () => ({ ok: true }), dispose: () => {} };
    }
    // The restart replacement spawns process.execPath, the bundled Bun in an npm install. Read it
    // now: Linux Bun resolves it lazily, and after npm swaps the package directory a first read
    // reports the retired binary as "(deleted)"; reading it once pins the boot path.
    const runtimePath = process.execPath;
    return createPackageTreeIntegrityGuard(observe, now, {
      ...options,
      runtimeReady: options.runtimeReady ?? (() => isRealBunBinary(runtimePath)),
    });
  }
