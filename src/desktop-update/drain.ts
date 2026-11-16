/**
 * Reading the installed CLI's `ocx stop --json` result for the headless Desktop updater (#8246).
 *
 * The same acceptance the Desktop app applies to its own drain (`desktop/src-tauri/src/runtime_stop.rs`):
 * the `ocx-stop/1` document and the process exit code must agree that this home's runtime is down.
 * Exit 79 (history cleanup incomplete) still stopped the runtime; everything else is a failure.
 */

/** The app's Windows drain budget; the CLI receives it as OCX_STOP_DEADLINE_MS. */
export const DRAIN_DEADLINE_MS = 75_000;
export const DRAIN_STOP_DEADLINE_ENV = "OCX_STOP_DEADLINE_MS";

export function parseDrainResult(stdout: string, exitCode: number | null): { ok: boolean; detail?: string } {
  const line = stdout.split(/\r?\n/).map(text => text.trim()).filter(text => text.startsWith("{")).at(-1);
  let summary: Record<string, unknown> | null = null;
  try { summary = line ? JSON.parse(line) as Record<string, unknown> : null; } catch { summary = null; }
  if (!summary || summary.schema !== "ocx-stop/1") {
    return { ok: false, detail: `unreadable stop result (exit ${exitCode ?? "none"})` };
  }
  const proxyDown = summary.proxy === "stopped" || summary.proxy === "stopped-orphan";
  const stopped = exitCode === 0 && summary.ok === true && summary.exitCode === 0 && summary.runtimeDown === true
    && ((summary.outcome === "stopped" && proxyDown) || (summary.outcome === "not-running" && summary.proxy === "not-running"));
  const historyOnly = exitCode === 79 && summary.exitCode === 79 && summary.outcome === "history-incomplete"
    && summary.runtimeDown === true && proxyDown;
  if (stopped || historyOnly) return { ok: true };
  const message = typeof summary.message === "string" ? `: ${summary.message.slice(0, 200)}` : "";
  return { ok: false, detail: `${String(summary.outcome)}/${String(summary.proxy)} exit ${exitCode ?? "none"}${message}` };
}
