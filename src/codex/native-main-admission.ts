import type { AdmissionLease } from "../lib/admission";
import {
  tryAcquireNativeMainProfileClaim as tryAcquireLifecycleNativeMainProfileClaim,
  tryClaimNativeMainProfileForTurn as tryClaimLifecycleNativeMainProfileForTurn,
} from "../server/lifecycle";
import {
  MAIN_CODEX_ACCOUNT_ID,
  MainAccountTokenRefreshError,
  MainAuthJsonChangedDuringRefreshError,
} from "./main-account";
import { isNativeMainTrafficBlocked } from "./native-profile-startup";
import { NativeProfileError } from "./native-profile-types";

export interface NativeMainTurnClaimDeps {
  /** Test seams for the synchronous precheck/claim/postcheck transition. */
  isTrafficBlocked?: typeof isNativeMainTrafficBlocked;
  claimTurn?: typeof tryClaimLifecycleNativeMainProfileForTurn;
}

/**
 * Admit a physical native-main credential read on an existing turn.
 *
 * Lifecycle admission owns the scoped switch/shutdown fence while the startup
 * gate owns retained journal/manual recovery. Keep their composition here so
 * low-level server lifecycle code does not import NativeProfileManager through
 * native-profile-startup and create a fragile dependency cycle.
 */
export function tryClaimNativeMainProfileForTurn(
  lease?: AdmissionLease,
  deps: NativeMainTurnClaimDeps = {},
): boolean {
  const isBlocked = deps.isTrafficBlocked ?? isNativeMainTrafficBlocked;
  const claimTurn = deps.claimTurn ?? tryClaimLifecycleNativeMainProfileForTurn;
  if (isBlocked()) return false;
  if (!claimTurn(lease)) return false;
  if (!isBlocked()) return true;

  // Recovery became visible between the precheck and lifecycle claim. This
  // request must not read auth.json. Keep the caller-owned turn claimed until
  // normal request cleanup: optional routed work may continue, and releasing
  // the whole turn here would let shutdown/profile switching overlap it.
  return false;
}

/** Acquire standalone ownership only when both native-main gates admit work. */
export function tryAcquireNativeMainProfileClaim(): AdmissionLease | null {
  if (isNativeMainTrafficBlocked()) return null;
  const claim = tryAcquireLifecycleNativeMainProfileClaim();
  if (!claim) return null;
  if (!isNativeMainTrafficBlocked()) return claim;
  claim.release();
  return null;
}

export interface NativeMainCredentialAdmissionDeps {
  /** Test seam for the synchronous admission precheck. */
  readonly acquireNativeMain?: () => AdmissionLease | null;
}

const NO_EXCLUDED_ACCOUNT_IDS: ReadonlySet<string> = new Set();
const NATIVE_MAIN_EXCLUDED_ACCOUNT_IDS: ReadonlySet<string> = new Set([MAIN_CODEX_ACCOUNT_ID]);

/**
 * Run credential-backed work inside the native-main lifecycle fence.
 *
 * The lease keeps startup recovery and profile drains from owning the physical
 * credential while the operation reads it. Cross-process ownership of the file
 * itself is already coordinated inside the refresh path's exclusive claim, so
 * this fence deliberately does not take the shared claim: holding it across an
 * operation that may refresh would ask for exclusive ownership against our own
 * shared lock, and holding it across the upstream work that follows would
 * stall an unrelated credential commit behind a network fetch.
 *
 * When the gate refuses, or the credential cannot be read because another
 * lifecycle owns it, the operation reruns with main excluded so independent
 * Pool work is never suppressed by main's unavailability.
 */
export async function withNativeMainCredentialAdmission<T>(
  operation: (excludeAccountIds: ReadonlySet<string>) => Promise<T>,
  deps: NativeMainCredentialAdmissionDeps = {},
): Promise<T> {
  const lease = (deps.acquireNativeMain ?? tryAcquireNativeMainProfileClaim)();
  if (!lease) return operation(NATIVE_MAIN_EXCLUDED_ACCOUNT_IDS);
  try {
    return await operation(NO_EXCLUDED_ACCOUNT_IDS);
  } catch (error) {
    if (!isNativeMainCredentialUnavailableError(error)) throw error;
    return await operation(NATIVE_MAIN_EXCLUDED_ACCOUNT_IDS);
  } finally {
    lease.release();
  }
}

/**
 * The credential-ownership failures that make main unavailable for one
 * operation: a foreign exclusive holder or an unsupported claim filesystem, a
 * writer that moved auth.json mid-refresh, or a grant that no longer
 * refreshes. Like a Pool credential failure, none of them may suppress
 * independent Pool discovery.
 */
function isNativeMainCredentialUnavailableError(error: unknown): boolean {
  return error instanceof NativeProfileError
    || error instanceof MainAuthJsonChangedDuringRefreshError
    || error instanceof MainAccountTokenRefreshError;
}
