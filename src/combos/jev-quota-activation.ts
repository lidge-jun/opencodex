/**
 * Activation owner for JEV advisory quota evidence.
 *
 * The decision snapshot (`src/providers/quota-decision-snapshot.ts`) is imported here and by
 * nothing on the core path. Core credential stores and quota producers call the slot in
 * `src/lib/decision-quota-sink.ts`; this module registers the snapshot-backed sink only while the
 * live config has a JEV combo with `decisionQuotaSignals: true`, and withdraws everything when the
 * last such combo is turned off, deleted or the config root changes.
 *
 * Activation replays the current stores through observe-only reads (`peekAuthStore`,
 * `peekCodexAccountRecordStore`, `peekMainDecisionRow`): no hardening, backup, write, credential
 * resolution or upstream probe, and never on a request's decision path. Stores keep no in-memory
 * cache, so this one bounded read at activation is what "publish once from the loaded stores" costs,
 * paid only by installs that opted in.
 */
import {
  clearDecisionAccountQuotas, invalidateDecisionKeyQuotas, observeDecisionKeyCredential, publishDecisionAccountQuota,
  publishDecisionKeyQuota, publishDecisionQuotaRoster, readLoadedDecisionKeyQuota, readLoadedDecisionQuotaPool, replaceDecisionKeyQuotas,
  setDecisionAccountUsable, withdrawDecisionQuotaRoster,
} from "../providers/quota-decision-snapshot";
import { captureAntigravityReceipt, observeAntigravityQuotaStore, replaceAntigravityQuotas } from "../providers/quota-decision-antigravity";
import { registerDecisionQuotaSink, type DecisionQuotaSink, type MainDecisionRow } from "../lib/decision-quota-sink";
import { registerLiveConfigObserver } from "../lib/state-store-registrations";
import { getConfigDir } from "../config/paths";
import { peekAuthStore } from "../oauth/store";
import { peekCodexAccountRecordStore } from "../codex/account-store";
import { peekMainDecisionRow } from "../codex/main-account-cache";
import { createHash } from "node:crypto";
import type { AuthStore } from "../oauth/store";
import type { CodexAccountCredentialRecord, OcxConfig } from "../types";

const POOL_PROVIDERS = ["anthropic", "codex", "codex-main"] as const;

/** Project an auth store the owner already read into the secret-free Anthropic roster (primary pool only); a failure withdraws so the pool reads as unknown. The generation is a one-way digest of the credential, never the credential itself. */
function publishAuthDecisionQuotaRoster(store: AuthStore): void {
  observeAntigravityQuotaStore(store);
  try {
    publishDecisionQuotaRoster("anthropic", (store.anthropic?.accounts ?? []).map(row => ({
      id: row.id,
      generation: createHash("sha256").update(JSON.stringify([row.credential.refresh, row.credential.access, row.credential.expires])).digest("hex"),
      usable: row.paused !== true && row.needsReauth !== true && Boolean(row.credential.access || row.credential.refresh),
    })));
  } catch {
    try { withdrawDecisionQuotaRoster("anthropic"); } catch { /* unknown */ }
  }
}

/** Project a Codex account store the owner already read into the secret-free roster (id, credential generation, usability); a failure withdraws. */
function publishCodexDecisionQuotaRoster(store: Readonly<Record<string, CodexAccountCredentialRecord>>): void {
  try {
    publishDecisionQuotaRoster("codex", Object.entries(store).map(([id, row]) => ({
      id, generation: row.generation,
      usable: !!row.credential && row.deletedAt == null && !row.codexValidationPending && !row.lastCodexValidationTerminal,
    })));
  } catch {
    try { withdrawDecisionQuotaRoster("codex"); } catch { /* unknown */ }
  }
}

/** Whether a config enables advisory quota signals on at least one JEV combo. */
export function jevQuotaSignalsWanted(config: Pick<OcxConfig, "combos"> | null | undefined): boolean {
  return Object.values(config?.combos ?? {}).some(combo => combo?.strategy === "jev" && combo.decisionQuotaSignals === true);
}

/** Publish the native-main row, or withdraw it; a failed publication withdraws so a previous row cannot linger (same guard as the auth/Codex projections). */
function publishMainRow(row: MainDecisionRow | undefined): void {
  try {
    if (row) publishDecisionQuotaRoster("codex-main", [{ id: "__main__", generation: row.generation, usable: row.usable }]);
    else withdrawDecisionQuotaRoster("codex-main");
  } catch {
    try { withdrawDecisionQuotaRoster("codex-main"); } catch { /* best-effort; the pool reads as unknown */ }
  }
}

const snapshotSink: DecisionQuotaSink = {
  observeKeyCredential: observeDecisionKeyCredential,
  invalidateKeyQuotas: invalidateDecisionKeyQuotas,
  publishKeyQuota: publishDecisionKeyQuota,
  publishAccountQuota: (provider, id, generation, windows, partial) => publishDecisionAccountQuota(provider, id, generation, windows, partial),
  setAccountUsable: setDecisionAccountUsable,
  clearAccountQuotas: clearDecisionAccountQuotas,
  authStoreLoaded: publishAuthDecisionQuotaRoster,
  codexStoreLoaded: publishCodexDecisionQuotaRoster,
  mainRosterChanged: row => publishMainRow(row),
  readKeyQuota: readLoadedDecisionKeyQuota,
  readPool: readLoadedDecisionQuotaPool,
  captureAntigravityReceipt,
  replaceCollectedQuotas: (keys, oauth) => { replaceDecisionKeyQuotas(keys); replaceAntigravityQuotas(oauth); },
};

let active: { detach: () => void; root: string } | undefined;

function withdrawAll(): void {
  for (const provider of POOL_PROVIDERS) withdrawDecisionQuotaRoster(provider);
  clearDecisionAccountQuotas();
  invalidateDecisionKeyQuotas();
}

/**
 * Replay the current stores into the snapshot through observe-only reads. Each pool fails closed to
 * unknown. Ownership is rechecked after every read: a reentrant notification that deactivates (or
 * restarts) during a read must not be followed by a publication from this stale replay.
 */
function replayCurrentStores(owner: object): void {
  const owns = () => active === owner;
  try { const store = peekAuthStore(); if (owns()) publishAuthDecisionQuotaRoster(store); } catch { if (owns()) withdrawDecisionQuotaRoster("anthropic"); }
  try { const store = peekCodexAccountRecordStore(); if (owns()) publishCodexDecisionQuotaRoster(store); } catch { if (owns()) withdrawDecisionQuotaRoster("codex"); }
  try { const row = peekMainDecisionRow(); if (owns()) publishMainRow(row); } catch { if (owns()) { try { withdrawDecisionQuotaRoster("codex-main"); } catch { /* unknown */ } } }
}

/** Detach the sink first, so no producer can write while the snapshot is withdrawn. */
export function deactivateJevQuotaActivation(): void {
  const current = active;
  if (!current) return;
  active = undefined;
  current.detach();
  try { withdrawAll(); } catch { /* the snapshot is unreachable once detached */ }
}

/** Converge activation with a live config: register on the first enabling combo, withdraw after the last, and restart on a config root change. Never throws. */
export function reconcileJevQuotaActivation(config: OcxConfig): void {
  try {
    const wanted = jevQuotaSignalsWanted(config);
    const root = getConfigDir();
    if (active && (!wanted || active.root !== root)) deactivateJevQuotaActivation();
    if (!wanted || active) return;
    const owner = { detach: registerDecisionQuotaSink(snapshotSink), root };
    active = owner;
    replayCurrentStores(owner);
  } catch {
    deactivateJevQuotaActivation();
  }
}

/** Whether the snapshot-backed sink is currently registered by this owner. */
export function jevQuotaActivationActive(): boolean { return active !== undefined; }

let stopCurrent: (() => void) | undefined;

/**
 * Live-owner lifecycle, started by the server's optional-subsystem set once it is serving.
 * Registers the live-config observer and reconciles once with the start-time config; the returned
 * stop unregisters and deactivates. A second start replaces the first.
 */
export function startJevQuotaActivation(config: OcxConfig): () => void {
  stopCurrent?.();
  const unregister = registerLiveConfigObserver("jev-quota-activation", reconcileJevQuotaActivation);
  const stop = () => {
    if (stopCurrent !== stop) return;
    stopCurrent = undefined;
    unregister();
    deactivateJevQuotaActivation();
  };
  stopCurrent = stop;
  reconcileJevQuotaActivation(config);
  return stop;
}
