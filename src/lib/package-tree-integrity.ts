import { statSync } from "node:fs";

export interface PackageTreeObservation {
  readonly device: bigint;
  readonly inode: bigint;
  readonly changeTimeNs: bigint;
  readonly size: bigint;
}

export type PackageTreeIntegrityStatus =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "package_tree_replaced" | "package_tree_unreadable" };

export interface PackageTreeIntegrityGuard {
  status(): PackageTreeIntegrityStatus;
}

type ObservePackageTree = () => PackageTreeObservation | null;

const packageManifestUrl = new URL("../../package.json", import.meta.url);

function observePackageManifest(): PackageTreeObservation | null {
  try {
    const stat = statSync(packageManifestUrl, { bigint: true });
    return {
      device: stat.dev,
      inode: stat.ino,
      changeTimeNs: stat.ctimeNs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function sameObservation(left: PackageTreeObservation, right: PackageTreeObservation): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.changeTimeNs === right.changeTimeNs
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

export function createPackageTreeIntegrityGuard(
  observe: ObservePackageTree = observePackageManifest,
  now: () => number = Date.now,
): PackageTreeIntegrityGuard {
  const boot = observe();
  let lastOkAt: number | null = null;
  return {
    status(): PackageTreeIntegrityStatus {
      const at = now();
      if (lastOkAt !== null && at - lastOkAt < PACKAGE_TREE_RECHECK_MS) return { ok: true };
      const current = observe();
      if (boot === null || current === null) return { ok: false, reason: "package_tree_unreadable" };
      if (!sameObservation(boot, current)) return { ok: false, reason: "package_tree_replaced" };
      lastOkAt = at;
      return { ok: true };
    },
  };
}
