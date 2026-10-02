import type { KeyboardEvent } from "react";
import { navigateHash, normalizeHashPath } from "../hash-routing";

export const CLAUDE_TABS = ["account", "code", "desktop", "settings"] as const;
export type ClaudeTab = typeof CLAUDE_TABS[number];
export function readClaudeTab(hash = window.location.hash, hasAnthropic = false): ClaudeTab {
  const suffix = normalizeHashPath(hash).split("/")[1];
  return CLAUDE_TABS.find(tab => tab === suffix) ?? (hasAnthropic ? "account" : "code");
}
export function selectClaudeTab(tab: ClaudeTab): void {
  navigateHash(`claude/${tab}`);
}
export function claudeTabKeyDown(event: KeyboardEvent): void {
  const index = CLAUDE_TABS.findIndex(tab => event.currentTarget.id === `claude-tab-${tab}`);
  let next: number;
  if (event.key === "ArrowLeft") next = (index + CLAUDE_TABS.length - 1) % CLAUDE_TABS.length;
  else if (event.key === "ArrowRight") next = (index + 1) % CLAUDE_TABS.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = CLAUDE_TABS.length - 1;
  else return;
  event.preventDefault();
  selectClaudeTab(CLAUDE_TABS[next]);
  document.getElementById(`claude-tab-${CLAUDE_TABS[next]}`)?.focus({ preventScroll: true });
}
