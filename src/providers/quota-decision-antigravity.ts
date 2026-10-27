/** Optional snapshot owner. No store reads: roster input comes only from loaded-store notifications. */
import { getConfigDir } from "../config/paths";
import { captureConfigGeneration } from "../lib/state-store-sweeper";
import { ANTIGRAVITY_OAUTH_STORE_KEY, antigravityQuotaCredentialGeneration, antigravityQuotaEligible, antigravityQuotaPolicy } from "./antigravity-quota-identity";
import type { AuthStore } from "../oauth/store";
import type { OcxProviderConfig } from "../types";
import type { AntigravityQuotaObservation, AntigravityQuotaReceipt } from "../lib/decision-quota-sink";
import type { DecisionQuotaWindow } from "./quota-decision-snapshot";

type Owner = { root: string; id: string; generation: string; revision: string };
type Receipt = Owner & { owner: Owner; name: string; policy: string; configGeneration: number; epoch: number };
let owner: Owner | undefined;
let epoch = 0;
const receipts = new WeakMap<AntigravityQuotaReceipt, Receipt>();
let observations = new Map<string, { receipt: Receipt; windows: readonly DecisionQuotaWindow[] }>();

/** Any roster transition retires old receipts, including switching away and back. */
export function observeAntigravityQuotaStore(store: AuthStore): void {
  const set = store[ANTIGRAVITY_OAUTH_STORE_KEY];
  const account = set?.accounts.length === 1 ? set.accounts[0] : undefined;
  const next = account && set?.activeAccountId === account.id && !account.paused && !account.needsReauth
    && account.credential.access && account.credential.projectId
    ? { root: getConfigDir(), id: account.id, generation: antigravityQuotaCredentialGeneration(account.credential), revision: JSON.stringify([account.loginId, account.pauseRevision, set.selectionRevision]) } : undefined;
  if (owner?.root === next?.root && owner?.id === next?.id && owner?.generation === next?.generation && owner?.revision === next?.revision) return;
  owner = next;
  invalidateAntigravityQuota();
}

/** Epoch fences also retire outstanding probes on explicit cache/evidence invalidation. */
export function invalidateAntigravityQuota(): void { epoch++; observations.clear(); }

export function captureAntigravityReceipt(name: string, provider: OcxProviderConfig, id: string, generation: string): AntigravityQuotaReceipt | undefined {
  if (!owner || owner.root !== getConfigDir() || owner.id !== id || owner.generation !== generation || !antigravityQuotaEligible(name, provider)) return undefined;
  const token: AntigravityQuotaReceipt = Object.freeze({ kind: "antigravity" });
  receipts.set(token, { ...owner, owner, name, policy: antigravityQuotaPolicy(name, provider), configGeneration: captureConfigGeneration(), epoch });
  return token;
}

function current(receipt: Receipt): boolean {
  return receipt.owner === owner && receipt.root === getConfigDir() && receipt.epoch === epoch && receipt.configGeneration === captureConfigGeneration();
}

/** Only accepted, live immutable receipts can retain omitted family rows; clocks never change. */
export function replaceAntigravityQuotas(rows: readonly AntigravityQuotaObservation[]): void {
  const next = new Map<string, { receipt: Receipt; windows: readonly DecisionQuotaWindow[] }>();
  for (const row of rows.slice(0, 256)) {
    const receipt = receipts.get(row.receipt);
    if (!receipt) continue;
    if (!current(receipt) || receipt.name !== row.name || !antigravityQuotaEligible(row.name, row.provider)
      || receipt.policy !== antigravityQuotaPolicy(row.name, row.provider)) { receipts.delete(row.receipt); continue; }
    const previous = observations.get(receipt.name);
    const fresh = row.windows.length > 64 ? [] : row.windows.filter(window => window.family === "gem" || window.family === "cla");
    const retained = previous && current(previous.receipt) && previous.receipt.owner === receipt.owner && previous.receipt.policy === receipt.policy
      ? previous.windows.filter(window => !fresh.some(value => value.family === window.family && value.window === window.window)) : [];
    next.set(receipt.name, { receipt, windows: [...retained, ...fresh].map(window => ({ ...window })) });
  }
  observations = next;
}

export function readAntigravityQuota(name: string, provider: OcxProviderConfig): readonly DecisionQuotaWindow[] | undefined {
  const row = observations.get(name);
  if (!row || !current(row.receipt) || !antigravityQuotaEligible(name, provider) || row.receipt.policy !== antigravityQuotaPolicy(name, provider)) return undefined;
  return row.windows.map(window => ({ ...window }));
}
