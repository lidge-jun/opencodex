import type { SecurityRole } from "./types";

const ROLE_RANK: Record<SecurityRole, number> = {
  security_viewer: 0,
  security_operator: 1,
  security_reviewer: 2,
  security_admin: 3,
};

export function canReadSecurity(role: SecurityRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.security_viewer;
}

export function canOperateCampaign(role: SecurityRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.security_operator;
}

export function canApprove(role: SecurityRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.security_reviewer;
}

export function canAdmin(role: SecurityRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.security_admin;
}

export function parseSecurityRole(raw: string | undefined | null): SecurityRole {
  if (raw === "security_operator" || raw === "security_reviewer" || raw === "security_admin" || raw === "security_viewer") {
    return raw;
  }
  return "security_viewer";
}
