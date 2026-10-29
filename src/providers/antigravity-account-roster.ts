import { getConfigDir } from "../config/paths";
import { credentialGeneration, getAccountCredentialWithStatus } from "../oauth/store";
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
 * Refreshing discovery exposes the union of usable accounts' discovered rows. This store keeps
 * each account's own last roster and credential generation so
 * that account selection can prefer an account that lists the requested model, instead of
 * landing a 5.5 request on a 4.6-only account. Absence of a roster is "unknown", never "no":
 * an account that was never active during discovery stays fully usable.
 */

/** A roster older than this is treated as unknown; entitlements change with plan and rollout. */
export const ANTIGRAVITY_ACCOUNT_ROSTER_TTL_MS = 6 * 60 * 60 * 1000;
export const ANTIGRAVITY_MODEL_DENIAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Logical ordering survives observations completed in the same millisecond. */
let observationOrder = 0;
export interface AntigravityModelObservation { readonly configDir: string; readonly order: number }
export function captureAntigravityModelObservation(): AntigravityModelObservation {
  return { configDir: getConfigDir(), order: ++observationOrder };
}
function accountGeneration(provider: string, accountId: string): string | undefined {
  const row = getAccountCredentialWithStatus(provider, accountId);
  return row ? credentialGeneration(row.credential) : undefined;
}
function denialModelId(modelId: string): string {
  const id = modelId.trim();
  return canonicalAntigravityUsageModel(Object.hasOwn(ANTIGRAVITY_MODEL_ALIASES, id) ? ANTIGRAVITY_MODEL_ALIASES[id]! : id);
}

interface AccountRoster {
  readonly ids: ReadonlySet<string>;
  readonly modelIds: readonly string[];
  readonly observedAt: number;
  readonly generation?: string;
  readonly order: number;
}

const rosters = new Map<string, AccountRoster>();
const modelDenials = new Map<string, Map<string, { generation: string; order: number; deniedAt: number }>>();

/** Admit only evidence from the credential actually sent, in the captured configuration home. */
export function recordAntigravityModelDenial(
  provider: string, accountId: string, modelId: string,
  sent: AntigravityModelObservation & { readonly generation: string }, now = Date.now(),
): boolean {
  if (getConfigDir() !== sent.configDir || accountGeneration(provider, accountId) !== sent.generation) return false;
  const key = rosterKey(provider, accountId);
  const roster = rosters.get(key);
  const id = denialModelId(modelId);
  if (!id) return false;
  if (roster?.generation === sent.generation && roster.order > sent.order
    && (roster.ids.has(id) || roster.ids.has(modelId.trim()))) return false;
  let denials = modelDenials.get(key);
  if (!denials) {
    if (modelDenials.size >= 2000) modelDenials.delete(modelDenials.keys().next().value!);
    modelDenials.set(key, denials = new Map());
  }
  const previous = denials.get(id);
  if (previous && previous.order > sent.order) return false;
  if (denials.size >= 2000 && !denials.has(id)) denials.delete(denials.keys().next().value!);
  denials.set(id, { generation: sent.generation, order: sent.order, deniedAt: now });
  return true;
}

function rosterKey(providerName: string, accountId: string): string {
  return `${getConfigDir()}\0${providerName}\0${accountId}`;
}

/** Record one account's discovered roster: picker ids, representative wire ids, and tier wire ids. */
export function recordAntigravityAccountRoster(
  providerName: string,
  accountId: string,
  models: readonly AntigravityAvailableModel[],
  now = Date.now(),
  observation = captureAntigravityModelObservation(),
): void {
  if (!providerName || !accountId || observation.configDir !== getConfigDir()) return;
  const key = rosterKey(providerName, accountId);
  const generation = accountGeneration(providerName, accountId);
  const previous = rosters.get(key);
  if (previous && previous.generation === generation && previous.order > observation.order) return;
  const ids = new Set<string>();
  for (const model of models) {
    ids.add(model.id);
    ids.add(model.wireModelId);
    for (const wire of Object.values(model.effortWireModelIds ?? {})) if (wire) ids.add(wire);
  }
  rosters.set(key, {
    ids,
    modelIds: models.map(model => model.id),
    observedAt: now,
    generation,
    order: observation.order,
  });
  const denials = modelDenials.get(key);
  for (const id of ids) {
    const key = denialModelId(id);
    const denial = denials?.get(key);
    if (denial && denial.order <= observation.order) denials!.delete(key);
  }
}

function freshRoster(providerName: string, accountId: string, now: number): AccountRoster | undefined {
  const roster = rosters.get(rosterKey(providerName, accountId));
  if (!roster || now - roster.observedAt > ANTIGRAVITY_ACCOUNT_ROSTER_TTL_MS
    || roster.generation !== accountGeneration(providerName, accountId)) return undefined;
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
  const id = modelId.trim();
  if (!id) return undefined;
  const key = rosterKey(providerName, accountId);
  const canonicalId = denialModelId(id);
  const denial = modelDenials.get(key)?.get(canonicalId);
  const roster = freshRoster(providerName, accountId, now);
  if (denial && denial.generation === accountGeneration(providerName, accountId)
    && now - denial.deniedAt <= ANTIGRAVITY_MODEL_DENIAL_TTL_MS
    && (!roster || denial.order >= roster.order)) return false;
  if (!roster) return undefined;
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
    modelDenials.delete(rosterKey(providerName, accountId));
    return;
  }
  rosters.clear();
  modelDenials.clear();
}
