import type { CodexAccountEntry } from "./hooks/useCodexAccountPool";

export interface CreditSpendSummary {
  enabled: number;
  total: number;
}

/** Spending credits is opt-in, so a row without the field counts as off. */
export function creditSpendSummary(rows: readonly CodexAccountEntry[]): CreditSpendSummary {
  return { enabled: rows.filter(row => row.creditsAfterLimit === true).length, total: rows.length };
}
