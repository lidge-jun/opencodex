/** Request-local conversation ownership for opt-in generic OAuth pools. No credentials are retained. */
import { createHash } from "node:crypto";
import { getConfigDir } from "../config/paths";
import { subscribeAccountSelections } from "../lib/account-selection-events";
import type { OcxConfig } from "../types";
import { classifyModelFamilyForQuota } from "./account-quota-rank";
import { eligibleFailoverAccounts, isGenericFailoverProvider, preferKiroModelSupport, preferredInitialAccount } from "./generic-account-failover";
import type { OAuthAccessSnapshot } from "./index";
import { captureOAuthAccountSelection, credentialGeneration, getAccountCredentialWithStatus } from "./store";
import type { OAuthAccountSelection } from "./types";

const IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 2_000;
const bindings = new Map<string, { accountId: string; lastUsedAt: number; selection: OAuthAccountSelection }>();
const prefix = (provider: string) => `${JSON.stringify([getConfigDir(), provider])}\u0000`;
const key = (provider: string, session: string) => prefix(provider) + "session:" + createHash("sha256").update(session).digest("hex");
const cursorKey = (provider: string) => prefix(provider) + "fill-first";

/** A persisted operator/roster/policy change revokes old session choices before its writer returns. */
export function clearGenericSessionAffinity(provider?: string): void {
  if (!provider) { bindings.clear(); return; }
  const scope = prefix(provider);
  for (const id of bindings.keys()) if (id.startsWith(scope)) bindings.delete(id);
}

export function clearGenericSessionAffinityForAccount(provider: string, accountId: string): void {
  const scope = prefix(provider);
  for (const [id, entry] of bindings) {
    if (id.startsWith(scope) && entry.accountId === accountId) bindings.delete(id);
  }
}
subscribeAccountSelections(event => { if (event.kind === "oauth") clearGenericSessionAffinity(event.provider); });

/** Unlike new-session strategy selection, keeping the surviving account needs no 2+ quorum. */
export function genericSessionAffinityEnabled(config: OcxConfig, provider: string): boolean {
  const row = config.providers[provider];
  const enabled = !!row && row.disabled !== true && provider !== "anthropic2" && isGenericFailoverProvider(provider, row)
    && row.oauthAccountFailover?.sessionAffinity === "conversation"
    && (row.oauthAccountFailover.enabled ?? config.oauthAccountFailover?.enabled) === true;
  if (!enabled) clearGenericSessionAffinity(provider);
  return enabled;
}

export function genericSessionAccountEligible(
  config: OcxConfig, provider: string, accountId: string, model?: string | null, now = Date.now(), allowActiveFallback = false,
): boolean {
  const eligible = eligibleFailoverAccounts(provider, now, classifyModelFamilyForQuota(provider, model));
  // Existing conversation ownership is independent of transient per-account load.
  if (preferKiroModelSupport(provider, eligible, model).includes(accountId)) return true;
  // Cached automatic exclusions remain preferences when no alternative exists. Preserve the
  // ordinary active/singleton attempt and its upstream refusal instead of inventing a conflict.
  if (!allowActiveFallback || eligible.length > 0 || captureOAuthAccountSelection(provider)?.accountId !== accountId) return false;
  const row = getAccountCredentialWithStatus(provider, accountId);
  return !!row && !row.paused && !row.needsReauth;
}

/** Peek only. The admitted snapshot, never a speculative token lookup, establishes ownership. */
export function genericSessionAccount(
  config: OcxConfig, provider: string, session: string | null, model?: string | null, now = Date.now(),
): string | null {
  if (!genericSessionAffinityEnabled(config, provider) || !session) return null;
  return readBinding(config, provider, key(provider, session), model, now);
}

function readBinding(config: OcxConfig, provider: string, id: string, model: string | null | undefined, now: number): string | null {
  const bound = bindings.get(id);
  if (!bound) return null;
  const current = captureOAuthAccountSelection(provider);
  if (!current || current.accountId !== bound.selection.accountId || current.revision !== bound.selection.revision
    || now - bound.lastUsedAt >= IDLE_TTL_MS || now < bound.lastUsedAt
    || !genericSessionAccountEligible(config, provider, bound.accountId, model, now)) {
    bindings.delete(id);
    return null;
  }
  return bound.accountId;
}

/** New sessions use the configured strategy; an ineligible active account cannot defeat release. */
export function preferredGenericSessionAccount(
  config: OcxConfig, provider: string, session: string | null, model?: string | null, now = Date.now(),
): string | null {
  if (!genericSessionAffinityEnabled(config, provider)) return null;
  const bound = genericSessionAccount(config, provider, session, model, now);
  if (bound) return bound;
  const cursor = readBinding(config, provider, cursorKey(provider), model, now);
  const active = cursor ?? captureOAuthAccountSelection(provider)?.accountId;
  const preferred = preferredInitialAccount(config, provider, now, model, active);
  if (preferred) return preferred;
  if (active && genericSessionAccountEligible(config, provider, active, model, now)) return active;
  return preferKiroModelSupport(provider,
    eligibleFailoverAccounts(provider, now, classifyModelFamilyForQuota(provider, model)), model, config)[0]
    ?? captureOAuthAccountSelection(provider)?.accountId ?? null;
}

/**
 * Validate against the operator's persisted selection without moving it. ALL automatic choices
 * in affinity mode use this receipt, including unkeyed requests and failovers, so concurrent
 * conversations cannot invalidate each other's selection revision. Manual A→B→A still fences.
 */
export function admitGenericSessionAccount(
  config: OcxConfig, provider: string, expected: OAuthAccountSelection,
  snapshot: OAuthAccessSnapshot, model?: string | null, modeEnabled = genericSessionAffinityEnabled(config, provider),
): OAuthAccountSelection | null {
  if (!modeEnabled || snapshot.provider !== provider) return null;
  const current = captureOAuthAccountSelection(provider);
  if (!current || current.accountId !== expected.accountId || current.revision !== expected.revision) return null;
  const row = getAccountCredentialWithStatus(provider, snapshot.accountId);
  if (!row || row.paused || row.needsReauth || credentialGeneration(row.credential) !== snapshot.generation
    || !genericSessionAccountEligible(config, provider, snapshot.accountId, model, Date.now(), true)) return null;
  return current;
}

export function bindGenericSessionAccount(
  config: OcxConfig, provider: string, session: string | null, accountId: string, model?: string | null, now = Date.now(),
): void {
  if (!genericSessionAffinityEnabled(config, provider)
    || !genericSessionAccountEligible(config, provider, accountId, model, now)) return;
  for (const [id, entry] of bindings) {
    if (now - entry.lastUsedAt >= IDLE_TTL_MS || now < entry.lastUsedAt) bindings.delete(id);
  }
  const selection = captureOAuthAccountSelection(provider);
  if (!selection) return;
  const keep = (id: string) => {
    bindings.delete(id);
    bindings.set(id, { accountId, lastUsedAt: now, selection });
  };
  const hit = session && genericSessionAccount(config, provider, session, model, now) === accountId;
  if (!hit && config.pool?.kernel === true && config.providers[provider]?.oauthAccountFailover?.strategy === "fill-first")
    keep(cursorKey(provider));
  if (session) keep(key(provider, session));
  while (bindings.size > MAX_ENTRIES) bindings.delete(bindings.keys().next().value!);
}
