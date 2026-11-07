import type { ManagedContribution } from "../clients/config-export";
import { fingerprint, type OwnershipRecord } from "./ownership";
import { isHermesAffinityUpgrade } from "./ownership-policy";
import type { IntegrationClientId } from "./registry";
import type { WriteOutcome } from "./writer";

/** Evaluate the actual transaction bytes, rather than a separate pre-coordinator read. */
export function hermesRefreshRefusal(input: {
  clientId: IntegrationClientId;
  before: string | null;
  configPath: string;
  record: OwnershipRecord | null;
  parsed: unknown;
  contribution: ManagedContribution;
}, allowAbsent: boolean): WriteOutcome | null {
  const { clientId, before, configPath, record, parsed, contribution } = input;
  if (allowAbsent || clientId !== "hermes" || !record) return null;
  // Opting into affinity still requires explicit Apply, including the supported workaround.
  if (isHermesAffinityUpgrade(parsed, record, contribution)) {
    return { ok: true, changed: false, state: "stale", clientId,
      message: "Hermes session affinity requires Apply in Integrations; refresh left the configuration unchanged" };
  }
  if (before !== null && fingerprint(before) !== record.fileFingerprint) {
    return { ok: false, reason: "conflict", state: "conflict", clientId,
      message: `${configPath} changed after the last Apply; review and Apply the pending catalog change in Connect → Hermes before automatic refresh resumes` };
  }
  return null;
}
