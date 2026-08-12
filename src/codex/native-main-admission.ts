import type { AdmissionLease } from "../lib/admission";
import {
  tryAcquireNativeMainProfileClaim as tryAcquireLifecycleNativeMainProfileClaim,
  tryClaimNativeMainProfileForTurn as tryClaimLifecycleNativeMainProfileForTurn,
} from "../server/lifecycle";
import { isNativeMainTrafficBlocked } from "./native-profile-startup";

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
