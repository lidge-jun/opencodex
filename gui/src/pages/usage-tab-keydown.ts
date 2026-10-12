import type { KeyboardEvent } from "react";

export type UsageTab = "report" | "companion";

export function readUsageTab(): UsageTab {
  return window.location.hash.replace(/^#\/?/, "") === "usage/companion" ? "companion" : "report";
}

export function selectUsageTab(next: UsageTab): void {
  window.location.hash = next === "report" ? "usage" : "usage/companion";
}

export function usageTabKeyDown(event: KeyboardEvent): void {
  if (event.key === "ArrowLeft" || event.key === "Home" || event.key === "ArrowRight" || event.key === "End") {
    event.preventDefault();
    const next = event.key === "ArrowLeft" || event.key === "Home" ? "report" : "companion";
    selectUsageTab(next);
    document.getElementById(`usage-tab-${next}`)?.focus();
  }
}
