/**
 * The Child half of the OCX-6 report: tell the Home, over the link, when this Child last applied
 * the Home's Codex settings, which digest it applied and when this runtime started.
 *
 * Runs in a linked client runtime. The first report goes out shortly after start (the tunnel may
 * still be coming up, so failures back off: 2, 5, 15, 30 then 60 seconds), and then once a minute,
 * so a Home that restarted and forgot the report learns it again within a minute. A Home that
 * predates the route (404) is not asked again. Timers are unref'd and never keep the process alive.
 */
import { codexSettingsDigest } from "../link/codex-settings";
import type { LinkChildParityReport } from "../link/child-parity";
import type { OcxClientConnectionConfig } from "../types";
import { readHomeCodexSettingsRecord, sendLinkChildParityReport, type HomeCodexSettingsRecord } from "./link-home";

export const LINK_PARITY_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
export const LINK_PARITY_PERIOD_MS = 60_000;

/** Process-wide, so a reporter rebuilt by a restart rollback keeps counting up (see `sequence`). */
let reportSequence = 0;
function nextReportSequence(): number {
  reportSequence += 1;
  return reportSequence;
}

export interface LinkParityReporter {
  start(): void;
  stop(): void;
}

export interface LinkParityReporterDeps {
  connection: OcxClientConnectionConfig;
  linkKey: () => string | null;
  /** ISO start time of this runtime. */
  runtimeStartedAt: string;
  readRecord?: (linkId: string) => HomeCodexSettingsRecord | null;
  send?: typeof sendLinkChildParityReport;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** The report for this Child's current record; null without link metadata. */
export function linkChildParityReport(
  connection: OcxClientConnectionConfig,
  runtimeStartedAt: string,
  record: HomeCodexSettingsRecord | null,
  sequence: number = nextReportSequence(),
): LinkChildParityReport | null {
  const linkId = connection.link?.linkId;
  const started = Date.parse(runtimeStartedAt);
  if (!linkId || !Number.isFinite(started)) return null;
  const applied = record ? Date.parse(record.appliedAt) : Number.NaN;
  return Number.isFinite(applied)
    ? { linkId, lastApplyAt: applied, runtimeStartedAt: started, appliedCodexSettingsDigest: codexSettingsDigest(record!.document.settings), sequence }
    : { linkId, lastApplyAt: null, runtimeStartedAt: started, appliedCodexSettingsDigest: null, sequence };
}

export function createLinkParityReporter(deps: LinkParityReporterDeps): LinkParityReporter {
  const readRecord = deps.readRecord ?? readHomeCodexSettingsRecord;
  const send = deps.send ?? sendLinkChildParityReport;
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return timer;
  });
  const clearTimer = deps.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let stopped = true;
  let failures = 0;

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimer(() => { void tick(); }, ms);
  };

  const tick = async (): Promise<void> => {
    timer = undefined;
    if (stopped) return;
    const key = deps.linkKey();
    const linkId = deps.connection.link?.linkId;
    let record: HomeCodexSettingsRecord | null = null;
    try { record = linkId ? readRecord(linkId) : null; } catch { record = null; }
    const report = linkChildParityReport(deps.connection, deps.runtimeStartedAt, record);
    const outcome = key && report ? await send(deps.connection, key, report).catch(() => "failed" as const) : "failed";
    if (outcome === "unsupported") { stopped = true; return; }
    if (outcome === "accepted") {
      failures = 0;
      schedule(LINK_PARITY_PERIOD_MS);
      return;
    }
    failures = Math.min(failures + 1, LINK_PARITY_RETRY_MS.length - 1);
    schedule(LINK_PARITY_RETRY_MS[failures]!);
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      failures = 0;
      schedule(LINK_PARITY_RETRY_MS[0]);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}
