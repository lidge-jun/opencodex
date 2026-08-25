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

export function createPackageTreeIntegrityGuard(
  observe: ObservePackageTree = observePackageManifest,
): PackageTreeIntegrityGuard {
  const boot = observe();
  return {
    status(): PackageTreeIntegrityStatus {
      const current = observe();
      if (boot === null || current === null) return { ok: false, reason: "package_tree_unreadable" };
      if (!sameObservation(boot, current)) return { ok: false, reason: "package_tree_replaced" };
      return { ok: true };
    },
  };
}
