import type { KeyboardEvent } from "react";
import type { LogSurfaceFilter } from "./logs-surface-filter";

const SURFACES: readonly LogSurfaceFilter[] = ["all", "claude", "codex", "grok"];

/** Implements arrow/Home/End navigation for the Logs surface radio group. */
export function logsSurfaceKeyDown(
  e: KeyboardEvent,
  current: LogSurfaceFilter,
  select: (surface: LogSurfaceFilter) => void,
) {
  const index = SURFACES.indexOf(current);
  let nextIndex = -1;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") nextIndex = (index + 1) % SURFACES.length;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") nextIndex = (index - 1 + SURFACES.length) % SURFACES.length;
  else if (e.key === "Home") nextIndex = 0;
  else if (e.key === "End") nextIndex = SURFACES.length - 1;
  if (nextIndex < 0) return;

  e.preventDefault();
  const next = SURFACES[nextIndex]!;
  select(next);
  document.getElementById(`logs-surface-${next}`)?.focus();
}
