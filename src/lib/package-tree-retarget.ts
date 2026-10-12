import {
  packageManifestPathIn,
  readPackageManifestVersionAt,
  sameObservation,
  type PackageTreeObservation,
} from "./package-tree-integrity";

/**
 * The package a service launcher would start right now: its canonical root and the identity of
 * the manifest inside it. Null when the launcher, its target or the manifest cannot be resolved.
 */
export interface LauncherTarget {
  readonly root: string;
  readonly manifest: PackageTreeObservation;
}

export type ResolveLauncherTarget = () => LauncherTarget | null;

export interface PackageTreeRetargetOptions {
  /** How often the launcher is re-resolved. Detection must not depend on inbound requests. */
  pollIntervalMs?: number;
  /** How long one complete target identity must hold before the restart is requested. */
  settleMs?: number;
  now?: () => number;
  /** Test seam; production uses an unref'd timer and returns its cancellation. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  /** Test seam for the settled target's version; production reads its package manifest. */
  readVersion?: (root: string) => string | undefined;
}

export interface PackageTreeRetargetWatch {
  /**
   * Version of the package the launcher now starts, once that target has held for the full
   * settle interval and still resolves to the same identity. A fenced `/healthz` reports it
   * when the running tree itself has gone, so `ocx restart` compares against what the
   * supervisor will actually start.
   */
  settledVersion(): string | undefined;
  /** Stops polling and invalidates any pending restart request. */
  dispose(): void;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SETTLE_MS = 5_000;

function sameTarget(left: LauncherTarget, right: LauncherTarget): boolean {
  return left.root === right.root && sameObservation(left.manifest, right.manifest);
}

/**
 * Watches a version-manager launcher whose target can move to a different package tree while the
 * running tree stays intact.
 *
 * The package-tree integrity fence only sees its own manifest. A manager that installs every
 * version into its own directory and then repoints a floating link (mise's `latest`) never
 * touches that manifest, so the fence neither restarts onto the new version nor recovers when
 * the old version is later pruned from under it. This watch compares what the launcher resolves
 * to with the running root instead.
 *
 * `onRetargeted` runs once, after one complete target identity (canonical root plus manifest
 * identity) has held for `settleMs`. Any change of either part, an unresolvable launcher, or a
 * return to the running root restarts the wait. A throwing handler is retried after another full
 * interval. After the supervisor restarts through the launcher, the new process's running root
 * is the target, so it never requests a second restart.
 */
export function createPackageTreeRetargetWatch(
  runningRoot: string,
  resolveTarget: ResolveLauncherTarget,
  onRetargeted: () => void,
  options: PackageTreeRetargetOptions = {},
): PackageTreeRetargetWatch {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const now = options.now ?? Date.now;
  const readVersion = options.readVersion ?? (root => readPackageManifestVersionAt(packageManifestPathIn(root)));
  const schedule = options.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  });

  let stopped = false;
  let cancelPoll: (() => void) | null = null;
  let candidate: LauncherTarget | null = null;
  let candidateSince = 0;
  let settled: LauncherTarget | null = null;

  const poll = (): void => {
    cancelPoll = null;
    if (stopped) return;
    const target = resolveTarget();
    if (target === null || target.root === runningRoot) {
      candidate = null;
      settled = null;
    } else if (candidate === null || !sameTarget(candidate, target)) {
      candidate = target;
      candidateSince = now();
      settled = null;
    } else if (now() - candidateSince >= settleMs) {
      settled = target;
      try {
        onRetargeted();
        stopped = true;
        return;
      } catch {
        // Restart admission refused (for example, the service home changed owner). Keep the
        // settled identity and ask again only after another full interval.
        candidateSince = now();
      }
    }
    cancelPoll = schedule(poll, pollIntervalMs);
  };

  cancelPoll = schedule(poll, pollIntervalMs);

  return {
    settledVersion: () => {
      if (settled === null) return undefined;
      const current = resolveTarget();
      if (current === null || !sameTarget(settled, current)) return undefined;
      return readVersion(settled.root);
    },
    dispose: () => {
      stopped = true;
      const cancel = cancelPoll;
      cancelPoll = null;
      cancel?.();
    },
  };
}
