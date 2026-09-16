import type { CredentialRole, SensitiveAction } from "./types";

const RANK: Record<CredentialRole, number> = {
  viewer: 0,
  agent: 1,
  developer: 2,
  operator: 3,
  admin: 4,
  owner: 5,
};

export function parseCredentialRole(raw: string | undefined | null): CredentialRole {
  if (raw === "owner" || raw === "admin" || raw === "operator" || raw === "developer" || raw === "viewer" || raw === "agent") {
    return raw;
  }
  return "viewer";
}

export function canViewMetadata(role: CredentialRole): boolean {
  return RANK[role] >= RANK.viewer;
}

export function canAddCredential(role: CredentialRole): boolean {
  return RANK[role] >= RANK.operator;
}

export function canValidate(role: CredentialRole): boolean {
  return RANK[role] >= RANK.operator;
}

export function canCreateLease(role: CredentialRole): boolean {
  return role === "agent" || RANK[role] >= RANK.developer;
}

export function requiresApproval(role: CredentialRole, action: SensitiveAction): boolean {
  if (action === "vault.reveal") return true;
  if (action === "credential.delete") return role !== "owner";
  if (action === "credential.revoke" || action === "credential.rotate" || action === "credential.export") {
    return RANK[role] < RANK.admin;
  }
  if (action === "policy.override" || action === "provider.disable" || action === "bulk.import") {
    return RANK[role] < RANK.admin;
  }
  return false;
}

export function canExecuteWithoutApproval(role: CredentialRole, action: SensitiveAction): boolean {
  return !requiresApproval(role, action);
}

