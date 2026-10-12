import { getAccountSet } from "../../oauth/store";
import { kiroEvidenceIdentity } from "../kiro-account-state-disk";

/** Capture login identity before an await and recheck it before publishing evidence. */
export function kiroProbeIdentity(accountId: string): string | undefined {
  const account = getAccountSet("kiro")?.accounts.find(row => row.id === accountId);
  return account ? kiroEvidenceIdentity(account) : undefined;
}

export function kiroProbeCurrent(accountId: string, identity: string | undefined): boolean {
  return identity !== undefined && kiroProbeIdentity(accountId) === identity;
}
