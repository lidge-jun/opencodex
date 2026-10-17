/**
 * Core-owned slot for JEV advisory quota evidence.
 *
 * Credential stores and quota producers sit on every install's core path, while advisory quota
 * evidence is an opt-in JEV feature (`decisionQuotaSignals: true` on a JEV combo). Producers call
 * these helpers, never the decision snapshot. With no registered sink every helper returns
 * immediately: nothing is projected, hashed, retained or published. The JEV activation owner
 * (`src/combos/jev-quota-activation.ts`) registers a sink only while a live config enables
 * signals, so the snapshot is imported by that owner alone.
 *
 * Calls are synchronous and never throw: advisory evidence must not alter a store load, a persist
 * or a quota update. Same pattern as `src/lib/optional-shutdown-hooks.ts`.
 */
import type { DecisionQuotaWindow } from "../providers/quota-decision-snapshot";
import type { OcxProviderConfig } from "../types";
import type { AuthStore } from "../oauth/store";
import type { CodexAccountCredentialRecord } from "../types";

export type DecisionPoolRead = readonly { id: string; usable: boolean; windows?: readonly DecisionQuotaWindow[] }[];
export interface MainDecisionRow { generation: number; usable: boolean }

export interface DecisionQuotaSink {
  observeKeyCredential(reference: string, resolved: string | undefined): void;
  invalidateKeyQuotas(): void;
  publishKeyQuota(name: string, provider: OcxProviderConfig, windows: readonly DecisionQuotaWindow[]): void;
  publishAccountQuota(provider: string, id: string, generation: string | number, windows: readonly DecisionQuotaWindow[], partial: boolean): void;
  setAccountUsable(provider: string, id: string, usable: boolean, generation?: string | number): void;
  clearAccountQuotas(provider?: string, id?: string): void;
  authStoreLoaded(store: AuthStore): void;
  codexStoreLoaded(store: Readonly<Record<string, CodexAccountCredentialRecord>>): void;
  /** undefined means the native-main row is unknown for the current root and must be withdrawn. */
  mainRosterChanged(row: MainDecisionRow | undefined): void;
  readKeyQuota(name: string, provider: OcxProviderConfig): readonly DecisionQuotaWindow[] | undefined;
  readPool(provider: string): DecisionPoolRead | undefined;
}

let sink: DecisionQuotaSink | undefined;

/** Install the active sink; the returned detach removes only this registration. */
export function registerDecisionQuotaSink(next: DecisionQuotaSink): () => void {
  sink = next;
  return () => { if (sink === next) sink = undefined; };
}

/** Whether any sink is registered; producers may use it to skip building evidence. */
export function decisionQuotaSinkActive(): boolean { return sink !== undefined; }

function forward(call: (active: DecisionQuotaSink) => void): void {
  const active = sink;
  if (!active) return;
  try { call(active); } catch { /* advisory evidence never alters the caller */ }
}

function read<T>(call: (active: DecisionQuotaSink) => T | undefined): T | undefined {
  const active = sink;
  if (!active) return undefined;
  try { return call(active); } catch { return undefined; }
}

export function observeDecisionKeyCredential(reference: string, resolved: string | undefined): void { forward(s => s.observeKeyCredential(reference, resolved)); }
export function invalidateDecisionKeyQuotas(): void { forward(s => s.invalidateKeyQuotas()); }
export function publishDecisionKeyQuota(name: string, provider: OcxProviderConfig, windows: readonly DecisionQuotaWindow[]): void { forward(s => s.publishKeyQuota(name, provider, windows)); }
export function publishDecisionAccountQuota(provider: string, id: string, generation: string | number, windows: readonly DecisionQuotaWindow[], partial = false): void { forward(s => s.publishAccountQuota(provider, id, generation, windows, partial)); }
export function setDecisionAccountUsable(provider: string, id: string, usable: boolean, generation?: string | number): void { forward(s => s.setAccountUsable(provider, id, usable, generation)); }
export function clearDecisionAccountQuotas(provider?: string, id?: string): void { forward(s => s.clearAccountQuotas(provider, id)); }
/** Auth store owner: call after a successful parse or persist with the store it already holds (`{}` for absent/invalid). */
export function notifyAuthStoreLoaded(store: AuthStore): void { forward(s => s.authStoreLoaded(store)); }
/** Codex account store owner: same contract as notifyAuthStoreLoaded. */
export function notifyCodexStoreLoaded(store: Readonly<Record<string, CodexAccountCredentialRecord>>): void { forward(s => s.codexStoreLoaded(store)); }
/** Native-main cache owner: the row is built from in-memory fields only. */
export function notifyMainRosterChanged(row: () => MainDecisionRow | undefined): void { forward(s => s.mainRosterChanged(row())); }
export function readLoadedDecisionKeyQuota(name: string, provider: OcxProviderConfig): readonly DecisionQuotaWindow[] | undefined { return read(s => s.readKeyQuota(name, provider)); }
export function readLoadedDecisionQuotaPool(provider: string): DecisionPoolRead | undefined { return read(s => s.readPool(provider)); }

/** Test-only: drop any registration a previous test left behind. */
export function resetDecisionQuotaSinkForTests(): void { sink = undefined; }
