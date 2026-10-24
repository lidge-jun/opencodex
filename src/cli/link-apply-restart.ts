/**
 * After `ocx sync` applies the Home's Codex settings on a Remote Link Child, restart the Child's
 * runtime so it started after the apply (OCX-6, P5).
 *
 * Idempotent: the record keeps its apply time while the settings digest is unchanged, so a runtime
 * that already started after it is left alone, and a sync after a failed restart retries it. The
 * restart is `ocx restart`'s own (`handleProxyRestart`); this module only decides whether to call
 * it and never starts a runtime that was not running, except to recover one an accepted restart
 * left absent.
 */
import type { HomeCodexSettingsRecord } from "../client/link-home";
import { findLiveProxy, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import type { ProxyRestartStartOutcome } from "./tray-proxy";

export type ApplyRestartOutcome =
  | { kind: "current" }
  | { kind: "not-running" }
  | { kind: "connection-changed" }
  | { kind: "restarted" }
  | { kind: "failed" };

export interface ApplyRestartDeps {
  findLive?: () => Promise<LiveProxy | null>;
  /** Epoch ms the live client runtime reports as its start, or null when it reports none. */
  readStartedAt?: (live: LiveProxy) => Promise<number | null>;
  restart: (startWhenStopped: (recoveringLiveRestart: boolean) => Promise<ProxyRestartStartOutcome>) => Promise<boolean>;
  recoveryStart: (recoveringLiveRestart: boolean) => Promise<ProxyRestartStartOutcome>;
  /** Still the connection this sync applied for (rechecked right before the restart). */
  connectionUnchanged: () => boolean;
}

export async function readClientRuntimeStartedAt(live: LiveProxy, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const response = await fetchImpl(`http://${probeHostname(live.hostname)}:${live.port}/healthz`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { pid?: unknown; startedAt?: unknown } | null;
    if (body?.pid !== live.pid || typeof body.startedAt !== "string") return null;
    const startedAt = Date.parse(body.startedAt);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

export async function restartRuntimeAfterApply(record: HomeCodexSettingsRecord, deps: ApplyRestartDeps): Promise<ApplyRestartOutcome> {
  const live = await (deps.findLive ?? (() => findLiveProxy()))();
  if (!live || live.role !== "client") return { kind: "not-running" };
  const appliedAt = Date.parse(record.appliedAt);
  // A runtime that reports no start time predates OCX-6 and cannot prove it is current.
  const startedAt = await (deps.readStartedAt ?? (target => readClientRuntimeStartedAt(target)))(live);
  if (startedAt !== null && Number.isFinite(appliedAt) && startedAt >= appliedAt) return { kind: "current" };
  if (!deps.connectionUnchanged()) return { kind: "connection-changed" };
  const ok = await deps.restart(async recovering => recovering
    ? deps.recoveryStart(true)
    : { status: "skipped" });
  return ok ? { kind: "restarted" } : { kind: "failed" };
}

/** One line for each outcome, printed by `ocx sync`. */
export function applyRestartMessage(outcome: ApplyRestartOutcome): string {
  switch (outcome.kind) {
    case "current": return "Client runtime already started after this apply; no restart needed.";
    case "not-running": return "No client runtime is running; the applied settings take effect when it starts.";
    case "connection-changed": return "The connection changed during sync; the client runtime was not restarted. Run 'ocx sync' again.";
    case "restarted": return "Client runtime restarted after applying the Home's settings.";
    case "failed": return "The client runtime restart did not complete; the previous runtime keeps serving. If a background service or the desktop app owns it, restart it there; otherwise retry with 'ocx restart' or 'ocx sync'.";
  }
}
