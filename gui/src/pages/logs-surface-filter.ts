/**
 * Surface bucketing for the Logs page, kept out of Logs.tsx so that module exports
 * components only — a page module that also exports helpers breaks Fast Refresh
 * (react-refresh/only-export-components).
 */
export type LogSurface = "claude" | "claude-desktop" | "grok";
export type LogSurfaceFilter = "all" | "claude" | "codex" | "grok";

/** Match Usage surface buckets: Claude includes Desktop; Codex is untagged. */
export function logMatchesSurface(log: { surface?: LogSurface }, filter: LogSurfaceFilter): boolean {
  if (filter === "all") return true;
  if (filter === "claude") return log.surface === "claude" || log.surface === "claude-desktop";
  if (filter === "grok") return log.surface === "grok";
  return log.surface === undefined;
}
