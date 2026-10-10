/** Loaded-only advisory evidence. No auth, disk, keychain, selectors, timers or probes. */
import { createHash } from "node:crypto";
import { getConfigDir } from "../config/paths";
import { captureConfigGeneration } from "../lib/state-store-sweeper";
import type { OcxProviderConfig } from "../types";

export interface DecisionQuotaWindow {
  window: "5h" | "weekly" | "monthly" | "fable" | "opus" | "sonnet";
  percent: number;
  observedAt: number;
  resetAt?: number;
}
export interface DecisionQuotaAccount {
  id: string;
  generation: string | number;
  usable: boolean;
}
type Evidence = { generation: string | number; windows: readonly DecisionQuotaWindow[] };
type Roster = { root: string; accounts: readonly DecisionQuotaAccount[] };
const rosters = new Map<string, Roster>();
const accounts = new Map<string, Evidence>();
const unusable = new Map<string, string | number | true>();
const POOL_PROVIDERS = new Set(["anthropic", "codex", "codex-main"]);
const MAX_ROWS = 1024;
const MAX_WINDOWS = 64;
let keyEpoch = 0;
const credentialVersions = new Map<string, string>();
/** Credential owner calls this after its normal read; JEV never invokes that owner. */
export function observeDecisionKeyCredential(reference: string, resolved: string | undefined): void {
  const version = createHash("sha256").update(resolved ?? "").digest("hex");
  const referenceId = createHash("sha256").update(reference).digest("hex");
  const previous = credentialVersions.get(referenceId);
  if (previous !== undefined && previous !== version) invalidateDecisionKeyQuotas();
  if (credentialVersions.size >= 256 && !credentialVersions.has(referenceId)) {
    credentialVersions.delete(credentialVersions.keys().next().value!);
    invalidateDecisionKeyQuotas();
  }
  credentialVersions.set(referenceId, version);
}
const keys = new Map<string, { root: string; epoch: number; configGeneration: number; policy: string; windows: readonly DecisionQuotaWindow[] }>();
/** Compose the per-provider, per-account map key. */
const accountKey = (provider: string, id: string) => `${provider}\0${id}`;
// Private policy digest, never returned or serialized. Resolving the configured credential is
// the collector's responsibility; request reads only this already-published generation.
/** Digest the provider settings a key-based evidence row was published under; it is never returned or serialized. */
function keyPolicy(provider: OcxProviderConfig): string {
  return createHash("sha256").update(JSON.stringify([
    provider.adapter, provider.baseUrl, provider.authMode, provider.apiKey, provider.apiKeyPool, provider.headers,
    provider.apiKey && credentialVersions.get(createHash("sha256").update(provider.apiKey).digest("hex")),
  ])).digest("hex");
}
/** Drop all key-based decision evidence and advance the epoch so earlier publications cannot be read. */
export function invalidateDecisionKeyQuotas(): void { keyEpoch++; keys.clear(); }
/** Publish decision windows for a single-key provider; pooled, disabled or non-key providers are never published, and the table is bounded. */
export function publishDecisionKeyQuota(name: string, provider: OcxProviderConfig, windows: readonly DecisionQuotaWindow[]): void {
  if (name.length > 1024 || provider.disabled || (provider.authMode ?? "key") !== "key" || (provider.apiKeyPool?.length ?? 0) > 1) return;
  if (keys.size >= 256 && !keys.has(name)) keys.delete(keys.keys().next().value!);
  keys.set(name, { root: getConfigDir(), epoch: keyEpoch, configGeneration: captureConfigGeneration(), policy: keyPolicy(provider), windows: copyWindows(windows) });
}
/** Read key-based evidence only when the config root, epoch, generation and provider policy still match what was published. */
export function readLoadedDecisionKeyQuota(name: string, provider: OcxProviderConfig): readonly DecisionQuotaWindow[] | undefined {
  const row = keys.get(name);
  if (!row || provider.disabled || (provider.authMode ?? "key") !== "key" || (provider.apiKeyPool?.length ?? 0) > 1
    || row.root !== getConfigDir() || row.epoch !== keyEpoch || row.configGeneration !== captureConfigGeneration()
    || row.policy !== keyPolicy(provider)) return undefined;
  return row.windows.map(row => ({ ...row }));
}
/** Replace a pool provider's roster; an oversized pool makes the whole pool unknown rather than hiding usable rows. */
export function publishDecisionQuotaRoster(provider: string, rows: readonly DecisionQuotaAccount[]): void {
  if (!POOL_PROVIDERS.has(provider)) return;
  const old = rosters.get(provider);
  if (old?.root !== getConfigDir()) {
    clearDecisionAccountQuotas(provider);
    for (const key of unusable.keys()) if (key.startsWith(`${provider}\0`)) unusable.delete(key);
  }
  // Overflow or oversized identities make the WHOLE pool unknown; never hide a usable row.
  if (rows.length > MAX_ROWS || rows.some(row => row.id.length > 1024
    || typeof row.generation === "string" && row.generation.length > 128)) {
    clearDecisionAccountQuotas(provider);
    rosters.delete(provider);
    return;
  }
  const live = new Map(rows.map(row => [row.id, row]));
  for (const row of old?.accounts ?? []) {
    if (live.get(row.id)?.generation !== row.generation) {
      const key = accountKey(provider, row.id);
      accounts.delete(key);
      if (!live.has(row.id) || unusable.get(key) !== true) unusable.delete(key);
    }
  }
  rosters.set(provider, { root: getConfigDir(), accounts: rows.map(row => ({ id: row.id, generation: row.generation, usable: row.usable })) });
}
/** Withdraw a pool provider's roster and evidence so readers see it as unknown rather than stale or empty. */
export function withdrawDecisionQuotaRoster(provider: string): void {
  clearDecisionAccountQuotas(provider);
  rosters.delete(provider);
  for (const key of unusable.keys()) if (key.startsWith(`${provider}\0`)) unusable.delete(key);
}
/** Publish windows for a roster account at the matching credential generation; a partial observation retains other windows of the same generation. */
export function publishDecisionAccountQuota(provider: string, id: string, generation: string | number, windows: readonly DecisionQuotaWindow[], partial = false): void {
  const roster = rosters.get(provider);
  if (roster?.root !== getConfigDir() || !roster.accounts.some(row => row.id === id && row.generation === generation)) return;
  const key = accountKey(provider, id);
  const previous = accounts.get(key);
  const retained = partial && previous?.generation === generation ? previous.windows.filter(row => !windows.some(next => row.window === next.window)) : [];
  accounts.set(key, { generation, windows: copyWindows([...retained, ...windows]) });
}
/** Read a pool's already-loaded roster with generation-matched windows; undefined when nothing is loaded for the current config root. */
export function readLoadedDecisionQuotaPool(provider: string): readonly { id: string; usable: boolean; windows?: readonly DecisionQuotaWindow[] }[] | undefined {
  const roster = rosters.get(provider);
  if (roster?.root !== getConfigDir()) return undefined;
  return roster.accounts.map(row => {
    const evidence = accounts.get(accountKey(provider, row.id));
    const quarantine = unusable.get(accountKey(provider, row.id));
    return { id: row.id, usable: row.usable && quarantine !== true && quarantine !== row.generation, ...(evidence?.generation === row.generation ? { windows: evidence.windows.map(window => ({ ...window })) } : {}) };
  });
}
/** Mark a roster account usable or unusable, optionally scoped to one credential generation so an unrelated generation is left intact. */
export function setDecisionAccountUsable(provider: string, id: string, usable: boolean, generation?: string | number): void {
  const roster = rosters.get(provider);
  if (roster?.root !== getConfigDir()) return;
  const row = roster.accounts.find(row => row.id === id && (generation === undefined || generation === row.generation));
  if (!row) return;
  const key = accountKey(provider, id);
  if (usable) {
    if (generation === undefined || unusable.get(key) !== true) unusable.delete(key);
  } else if (generation === undefined || unusable.get(key) !== true) unusable.set(key, generation ?? true);
}
/** Drop published account windows for a provider or one account, or for every provider when none is given. */
export function clearDecisionAccountQuotas(provider?: string, id?: string): void {
  for (const key of accounts.keys()) if (!provider || key.startsWith(`${provider}\0`) && (!id || key === accountKey(provider, id))) accounts.delete(key);
}
/** Copy only known window kinds into the bounded evidence table, so callers cannot retain a mutable reference. */
function copyWindows(windows: readonly DecisionQuotaWindow[]): DecisionQuotaWindow[] {
  if (windows.length > MAX_WINDOWS) return [];
  return windows.filter(row => ["5h", "weekly", "monthly", "fable", "opus", "sonnet"].includes(row.window)).map(row => ({ window: row.window, percent: row.percent, observedAt: row.observedAt, ...(row.resetAt !== undefined ? { resetAt: row.resetAt } : {}) }));
}
