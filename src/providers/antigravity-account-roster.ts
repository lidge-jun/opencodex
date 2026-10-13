import { getConfigDir } from "../config/paths";
import { ANTIGRAVITY_MODEL_ALIASES, canonicalAntigravityUsageModel, type AntigravityAvailableModel } from "./antigravity-models";

/**
 * Per-account Antigravity model rosters, taken from each account's own live
 * `:fetchAvailableModels` discovery.
 *
 * Google gates models per account, not per client. Measured 2026-10-14: one account lists
 * `claude-sonnet-4-6` / `claude-opus-4-6-thinking` and answers 404 "Requested entity was not
 * found" for every `claude-{opus,sonnet}-5-5-*` id, while other accounts list only the 5.5
 * families. Gemini 4 Argon is likewise Ultra / Enterprise only. Google documents Claude 5.5 as
 * needing a directly billed, non-trial Pro or Ultra plan and rolls it out gradually, so the static
 * lineup is a superset and only discovery says what one account can actually call.
 *
 * The catalog already exposes only the ACTIVE account's discovered rows (an authoritative live
 * roster drops static rows it did not return). This store keeps every account's last roster so
 * that account selection can prefer an account that lists the requested model, instead of
 * landing a 5.5 request on a 4.6-only account. Absence of a roster is "unknown", never "no":
 * an account that was never active during discovery stays fully usable.
 */

/** A roster older than this is treated as unknown; entitlements change with plan and rollout. */
export const ANTIGRAVITY_ACCOUNT_ROSTER_TTL_MS = 6 * 60 * 60 * 1000;

interface AccountRoster {
  readonly ids: ReadonlySet<string>;
  readonly modelIds: readonly string[];
  readonly observedAt: number;
}

const rosters = new Map<string, AccountRoster>();

function rosterKey(providerName: string, accountId: string): string {
  return `${getConfigDir()}\0${providerName}\0${accountId}`;
}

/** Record one account's discovered roster: picker ids, representative wire ids, and tier wire ids. */
export function recordAntigravityAccountRoster(
  providerName: string,
  accountId: string,
  models: readonly AntigravityAvailableModel[],
  now = Date.now(),
): void {
  if (!providerName || !accountId) return;
  const ids = new Set<string>();
  for (const model of models) {
    ids.add(model.id);
    ids.add(model.wireModelId);
    for (const wire of Object.values(model.effortWireModelIds ?? {})) if (wire) ids.add(wire);
  }
  rosters.set(rosterKey(providerName, accountId), {
    ids,
    modelIds: models.map(model => model.id),
    observedAt: now,
  });
}

function freshRoster(providerName: string, accountId: string, now: number): AccountRoster | undefined {
  const roster = rosters.get(rosterKey(providerName, accountId));
  if (!roster || now - roster.observedAt > ANTIGRAVITY_ACCOUNT_ROSTER_TTL_MS) return undefined;
  return roster;
}

/** The picker ids one account's last discovery returned, or `undefined` when unknown. */
export function antigravityAccountRosterModelIds(
  providerName: string,
  accountId: string,
  now = Date.now(),
): readonly string[] | undefined {
  return freshRoster(providerName, accountId, now)?.modelIds;
}

/**
 * Whether one account's roster lists `modelId`: `true` / `false` from its last discovery,
 * `undefined` when that account has no fresh roster. A picker id, one of its tier wire ids, or a
 * compatibility alias of either all count as listed.
 */
export function antigravityAccountSupportsModel(
  providerName: string,
  accountId: string,
  modelId: string,
  now = Date.now(),
): boolean | undefined {
  const roster = freshRoster(providerName, accountId, now);
  if (!roster) return undefined;
  const id = modelId.trim();
  if (!id) return undefined;
  if (roster.ids.has(id)) return true;
  const canonical = canonicalAntigravityUsageModel(id);
  if (roster.ids.has(canonical)) return true;
  const alias = Object.hasOwn(ANTIGRAVITY_MODEL_ALIASES, id) ? ANTIGRAVITY_MODEL_ALIASES[id] : undefined;
  return alias !== undefined && roster.ids.has(alias);
}

/** Forget rosters (one account, or all). For account removal and tests. */
export function clearAntigravityAccountRosters(providerName?: string, accountId?: string): void {
  if (providerName && accountId) {
    rosters.delete(rosterKey(providerName, accountId));
    return;
  }
  rosters.clear();
}
