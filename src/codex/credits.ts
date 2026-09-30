import type { OcxConfig } from "../types";

/** Display-only WHAM observation, never persisted or used for routing. */
export interface CodexCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  overageLimitReached?: boolean;
  balance?: string;
  approxLocalMessages?: [number, number];
  approxCloudMessages?: [number, number];
}

/**
 * An entry without `credits` means "this identity was observed and reported nothing to show".
 * Keeping that apart from "never observed" lets the account listing bypass the persisted quota
 * cache exactly once per identity after a restart, instead of on every dashboard poll.
 */
const observations = new Map<string, { identity: string; credits?: CodexCredits }>();

function messageRange(raw: unknown): [number, number] | undefined {
  return Array.isArray(raw) && raw.length === 2
    && raw.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
    ? [raw[0], raw[1]] : undefined;
}

/** Undefined keeps the prior observation; null or unusable input clears it. */
export function parseCodexCredits(raw: unknown): CodexCredits | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const credits: CodexCredits = {};
  if (typeof value.has_credits === "boolean") credits.hasCredits = value.has_credits;
  if (typeof value.unlimited === "boolean") credits.unlimited = value.unlimited;
  if (typeof value.overage_limit_reached === "boolean") credits.overageLimitReached = value.overage_limit_reached;
  if (typeof value.balance === "string" && /^\d+(\.\d+)?$/.test(value.balance)) credits.balance = value.balance;
  else if (typeof value.balance === "number" && Number.isFinite(value.balance) && value.balance >= 0) {
    // String(1e-7) is "1e-7"; the DTO promises a plain decimal string, which the GUI validates.
    credits.balance = value.balance.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
  }
  const local = messageRange(value.approx_local_messages);
  const cloud = messageRange(value.approx_cloud_messages);
  if (local) credits.approxLocalMessages = local;
  if (cloud) credits.approxCloudMessages = cloud;
  return Object.keys(credits).length > 0 ? credits : null;
}

export function rememberCodexCredits(accountId: string, identity: string, parsed: CodexCredits | null | undefined): void {
  const previous = observations.get(accountId);
  if (parsed === undefined) {
    // Omission keeps a same-identity observation; otherwise it still records that this identity
    // answered, so the listing stops forcing fresh reads for it.
    if (previous?.identity !== identity) observations.set(accountId, { identity });
    return;
  }
  observations.set(accountId, parsed === null ? { identity } : { identity, credits: structuredClone(parsed) });
}

export function codexCreditsFor(accountId: string, identity: string | null): CodexCredits | undefined {
  const observation = observations.get(accountId);
  if (!observation) return undefined;
  if (identity !== observation.identity) {
    observations.delete(accountId);
    return undefined;
  }
  return observation.credits ? structuredClone(observation.credits) : undefined;
}

/** Whether this identity has answered at least one usage read since the process started. */
export function hasCodexCreditsObservation(accountId: string, identity: string | null): boolean {
  const observation = observations.get(accountId);
  return observation !== undefined && identity !== null && observation.identity === identity;
}

export function codexCreditsDtoField(config: Pick<OcxConfig, "showCodexCredits">, accountId: string, identity: string | null): { credits?: CodexCredits } {
  const credits = codexCreditsFor(accountId, identity);
  return config.showCodexCredits === true && credits ? { credits } : {};
}

export function pruneCodexCredits(liveAccountIds: Iterable<string>): void {
  const live = new Set(liveAccountIds);
  for (const id of observations.keys()) if (!live.has(id)) observations.delete(id);
}

export function resetCodexCreditsForTests(): void {
  observations.clear();
}
