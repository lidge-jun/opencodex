import { adoptPersistedClaudeCode, mutatePersistedConfig } from "../config";
import type { OcxConfig } from "../types";
import { emptyDesktopProfile, type DesktopProfile } from "./desktop-profile";

/** Record the bytes already committed by the gateway writer, before cleanup of
 * the previous mode. Mode and fingerprint belong to one config transaction. */
export function recordCommittedDesktopGateway(
  config: Pick<OcxConfig, "claudeCode">,
  profile: DesktopProfile | undefined,
  fingerprint: string | undefined,
  appliedAt: string,
): void {
  const { appliedFingerprint: _oldFingerprint, appliedAt: _oldTime, ...base } = profile ?? emptyDesktopProfile();
  config.claudeCode = {
    ...config.claudeCode,
    desktopMode: "gateway",
    desktopProfile: {
      ...structuredClone(base),
      ...(fingerprint ? { appliedFingerprint: fingerprint, appliedAt } : {}),
    },
  };
}

export function persistCommittedDesktopGateway(
  snapshot: OcxConfig,
  profile: DesktopProfile | undefined,
  fingerprint: string | undefined,
): { ok: true } | { ok: false; reason: "missing" | "invalid" | "conflict" | "unavailable" } {
  const appliedAt = new Date().toISOString();
  try {
    const outcome = mutatePersistedConfig(current => {
      recordCommittedDesktopGateway(current, profile, fingerprint, appliedAt);
      return { changed: true, value: structuredClone(current.claudeCode) };
    });
    if (outcome.status === "unavailable") return { ok: false, reason: outcome.reason };
    adoptPersistedClaudeCode(snapshot, outcome.value);
    // The mode/profile pair IS the committed transaction, not mergeable state.
    // Without an armed baseline the three-way adopt cannot prove the live leaves
    // unchanged and keeps a stale live desktopMode over the bytes just saved, so
    // pin both leaves to the committed subtree after the disjoint-leaf merge.
    recordCommittedDesktopGateway(snapshot, profile, fingerprint, appliedAt);
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
