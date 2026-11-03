import { useCallback, useState } from "react";
import type { TKey } from "../i18n/shared";

/**
 * Optional columns of the Logs table. Time, status and the provider · model cell always show;
 * these can be hidden from the Columns menu, and the choice is a per-browser convenience kept
 * in localStorage (an unreadable store simply means "all visible").
 */
export type LogsOptionalColumn = "effort" | "tokens" | "rate" | "cost" | "duration";

export const LOGS_OPTIONAL_COLUMNS: ReadonlyArray<{ key: LogsOptionalColumn; label: TKey }> = [
  { key: "effort", label: "logs.col.effort" },
  { key: "tokens", label: "logs.col.tokens" },
  { key: "rate", label: "logs.col.tokPerSec" },
  { key: "cost", label: "logs.col.estimatedCost" },
  { key: "duration", label: "logs.col.duration" },
];

const STORAGE_KEY = "ocx.logs.columns.v1";
const ALL_VISIBLE: Record<LogsOptionalColumn, boolean> = { effort: true, tokens: true, rate: true, cost: true, duration: true };

function readColumns(): Record<LogsOptionalColumn, boolean> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return ALL_VISIBLE;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return ALL_VISIBLE;
    const next = { ...ALL_VISIBLE };
    for (const { key } of LOGS_OPTIONAL_COLUMNS) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "boolean") next[key] = value;
    }
    return next;
  } catch {
    return ALL_VISIBLE;
  }
}

export function useLogsColumns() {
  const [columns, setColumns] = useState(readColumns);
  // Each toggle is its own click, so `columns` is current here; the store write stays out of
  // the state updater, which React may replay.
  const toggle = useCallback((key: LogsOptionalColumn) => {
    const next = { ...columns, [key]: !columns[key] };
    setColumns(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private mode or a blocked store: the toggle still applies for this visit.
    }
  }, [columns]);
  return { columns, toggle };
}
