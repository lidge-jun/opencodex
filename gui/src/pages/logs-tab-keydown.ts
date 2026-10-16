import type { KeyboardEvent } from "react";
import { canonicalHashPath } from "../app-routing";

export type LogsTab = "logs" | "debug";

export function readTabFromHash(): LogsTab {
  return canonicalHashPath(window.location.hash) === "logs/debug" ? "debug" : "logs";
}

export function selectLogsTab(next: LogsTab) {
  window.location.hash = next === "debug" ? "logs/debug" : "logs";
}

export function logsTabKeyDown(e: KeyboardEvent) {
  if (e.key === "ArrowLeft" || e.key === "Home") {
    e.preventDefault();
    selectLogsTab("logs");
    document.getElementById("logs-tab-logs")?.focus();
  } else if (e.key === "ArrowRight" || e.key === "End") {
    e.preventDefault();
    selectLogsTab("debug");
    document.getElementById("logs-tab-debug")?.focus();
  }
}
