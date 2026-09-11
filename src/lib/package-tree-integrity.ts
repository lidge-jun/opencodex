import { statSync } from "node:fs";

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
}

type ObservePackageTree = () => PackageTreeObservation | null;
type PackageTreeRuntimeInstall = "bun" | "npm" | "pnpm" | "source";

const packageManifestUrl = new URL("../../package.json", import.meta.url);

function observePackageManifest(): PackageTreeObservation | null {
  try {
    const stat = statSync(packageManifestUrl, { bigint: true });
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

function sameObservation(left: PackageTreeObservation, right: PackageTreeObservation): boolean {
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
): PackageTreeIntegrityGuard {
  if (installer === "source") return { status: () => ({ ok: true }) };
  return createPackageTreeIntegrityGuard(observe, now);
}
