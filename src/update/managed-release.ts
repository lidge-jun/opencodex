import { trustedManagedReleaseOptIn } from "../cli/launcher-context";

/** Operators set this only when the host already manages this source installation's updates. */
export function managedReleaseDirectory(): boolean {
  return trustedManagedReleaseOptIn();
}
