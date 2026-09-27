import type { KeyboardEvent } from "react";

/**
 * Tab state for the Codex Set page, shaped exactly like Logs/Debug: exclusive
 * tabpanels whose choice lives in the hash, not in component state alone. That is
 * what makes the tab survive a refresh, a bookmark, and back/forward — and it is
 * the pattern devlog 004 §A3 identifies as the one the ask actually names.
 */
export type CodexSetTab = "multiauth" | "prompt" | "desktop";
const tabs: readonly CodexSetTab[] = ["multiauth", "prompt", "desktop"];

export function readCodexSetTabFromHash(): CodexSetTab {
  const hash = window.location.hash.replace(/^#\/?/, "");
  return hash === "codex-set/desktop" ? "desktop" : hash === "codex-set/prompt" ? "prompt" : "multiauth";
}

export function selectCodexSetTab(next: CodexSetTab): void {
  window.location.hash = next === "multiauth" ? "codex-set" : `codex-set/${next}`;
}

export function codexSetTabKeyDown(e: KeyboardEvent): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const current = tabs.indexOf(readCodexSetTabFromHash());
  const index = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (current + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  const next = tabs[index]!; selectCodexSetTab(next);
  document.getElementById(`codex-set-tab-${next}`)?.focus();
}
