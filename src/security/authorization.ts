import type { AuthorizationStatus, SecurityAuthorization } from "./types";

export function authorizationClockStatus(
  auth: Pick<SecurityAuthorization, "status" | "valid_from" | "valid_until">,
  now: Date = new Date(),
): AuthorizationStatus {
  if (auth.status === "REVOKED" || auth.status === "SUSPENDED" || auth.status === "DRAFT" || auth.status === "PENDING_VERIFICATION") {
    return auth.status;
  }
  const from = Date.parse(auth.valid_from);
  const until = Date.parse(auth.valid_until);
  if (!Number.isFinite(from) || !Number.isFinite(until)) return "EXPIRED";
  if (now.getTime() < from) return "PENDING_VERIFICATION";
  if (now.getTime() > until) return "EXPIRED";
  return "ACTIVE";
}

export function isAuthorizationExecutable(auth: SecurityAuthorization, now: Date = new Date()): boolean {
  return authorizationClockStatus(auth, now) === "ACTIVE";
}

export function actionClassAllowed(
  auth: Pick<SecurityAuthorization, "allowed_action_classes" | "prohibited_action_classes">,
  actionClass: string,
): boolean {
  if (auth.prohibited_action_classes.includes(actionClass)) return false;
  if (auth.allowed_action_classes.length === 0) return false;
  return auth.allowed_action_classes.includes(actionClass) || auth.allowed_action_classes.includes("*");
}
