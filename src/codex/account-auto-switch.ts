import type { OcxConfig } from "../types";
import { deleteConfigObjectChildKey } from "../config/rebase-provenance";
import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "./account-id";

export const DEFAULT_CODEX_AUTO_SWITCH_THRESHOLD = 80;
export const MIN_CODEX_AUTO_SWITCH_THRESHOLD = 0;
export const MAX_CODEX_AUTO_SWITCH_THRESHOLD = 100;

export function parseCodexAutoSwitchThreshold(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_CODEX_AUTO_SWITCH_THRESHOLD
    && value <= MAX_CODEX_AUTO_SWITCH_THRESHOLD
    ? value
    : null;
}

export function isCodexAccountAutoSwitchThresholdKey(key: unknown): key is string {
  return key === MAIN_CODEX_ACCOUNT_ID || isValidCodexAccountId(key);
}

/** Null means this account inherits the global threshold. */
export function getCodexAccountAutoSwitchThresholdOverride(
  config: OcxConfig,
  accountId: string,
): number | null {
  const thresholds = config.codexAccountAutoSwitchThresholds;
  if (!thresholds || !Object.hasOwn(thresholds, accountId)) return null;
  return parseCodexAutoSwitchThreshold(thresholds[accountId]);
}

/** Source-account threshold used by every usage-driven routing decision. */
export function getEffectiveCodexAutoSwitchThreshold(
  config: OcxConfig,
  accountId: string,
): number {
  const override = getCodexAccountAutoSwitchThresholdOverride(config, accountId);
  if (override !== null) return override;
  return config.autoSwitchThreshold ?? DEFAULT_CODEX_AUTO_SWITCH_THRESHOLD;
}

/** Store a concrete override, or null to restore global inheritance. */
export function setCodexAccountAutoSwitchThresholdOverride(
  config: OcxConfig,
  accountId: string,
  threshold: number | null,
): void {
  if (threshold === null) {
    deleteConfigObjectChildKey(config, "codexAccountAutoSwitchThresholds", accountId);
    return;
  }
  const entries = new Map(Object.entries(config.codexAccountAutoSwitchThresholds ?? {}));
  entries.set(accountId, threshold);
  config.codexAccountAutoSwitchThresholds = Object.fromEntries(entries);
}

export function forgetCodexAccountAutoSwitchThreshold(config: OcxConfig, accountId: string): void {
  setCodexAccountAutoSwitchThresholdOverride(config, accountId, null);
}
