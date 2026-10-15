export interface AdvisorModelRow {
  namespaced: string;
  disabled?: boolean;
  initialSelectionPending?: boolean;
}

/** Keep routing selectors opaque: labels and model display names are not model IDs. */
export function advisorModelValues(rows: readonly AdvisorModelRow[]): string[] {
  return [...new Set(rows.filter(row => !row.disabled && !row.initialSelectionPending)
    .map(row => row.namespaced))];
}
