/**
 * Runs the bounded completion probe across every model of one provider, one request at a time,
 * and offers to hide the models that failed. Nothing is disabled without a second consent.
 */
import { useEffect, useRef, useState } from "react";
import { confirmAction } from "../../action-dialogs";
import { readJsonOrThrow } from "../../fetch-json";
import { useI18n, useT } from "../../i18n/shared";
import { putModelVisibility } from "../../model-visibility";
import type { CompletionTestResult, ProbeGate } from "./ProviderCompletionTest";

type RowOutcome = "ok" | "failed" | "skipped";
type Row = { model: string; outcome: RowOutcome; latencyMs?: number; detail?: string };
type DisableState = { kind: "idle" } | { kind: "busy" } | { kind: "done"; count: number } | { kind: "error"; message: string };

type Props = { apiBase: string; provider: string; models: string[]; gate: ProbeGate; blocked: boolean };

/** A failure the upstream actually answered for this model; transport aborts and HTTP refusals are not evidence. */
function failedModelIds(rows: readonly Row[]): string[] {
  return rows.filter(row => row.outcome === "failed").map(row => row.model);
}

export default function ProviderBulkCompletionTest({ apiBase, provider, models, gate, blocked }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [disable, setDisable] = useState<DisableState>({ kind: "idle" });
  const flight = useRef<AbortController | null>(null);
  const disableFlight = useRef<AbortController | null>(null);
  useEffect(() => () => {
    if (flight.current) { flight.current.abort(); flight.current = null; gate.release(); }
    disableFlight.current?.abort(); disableFlight.current = null;
  }, [gate]);

  async function testOne(model: string, signal: AbortSignal): Promise<Row | { stop: string }> {
    try {
      const response = await fetch(`${apiBase}/api/providers/test-completion?name=${encodeURIComponent(provider)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, confirm: true }), signal,
      });
      const value = await readJsonOrThrow<CompletionTestResult>(response, t("pws.completion.failed"));
      if (!value) return { model, outcome: "skipped", detail: t("pws.completion.failed") };
      if (!value.applicable) {
        const detail = `${t("pws.completion.notApplicable")}: ${t(`pws.completion.${value.reason}`)}`;
        // Effective wire is resolved per model; a mixed-wire provider can still test later rows.
        return value.reason === "unsupported_adapter" ? { model, outcome: "skipped", detail } : { stop: detail };
      }
      if (value.ok) return { model, outcome: "ok", latencyMs: value.totalLatencyMs };
      // Admission refusals happen before upstream send and cannot establish a model failure.
      if (value.termination === "aborted" || ["credential_missing", "credential_changed", "destination_refused"].includes(value.error?.code ?? "")) {
        return { model, outcome: "skipped", detail: value.error?.code ?? "aborted" };
      }
      const detail = value.error
        ? `${value.error.code}${value.error.status !== undefined ? ` (${value.error.status})` : ""}`
        : value.termination;
      if (value.error?.code === "http_status" && [401, 403, 429].includes(value.error.status ?? 0)) {
        return { model, outcome: "skipped", detail };
      }
      return { model, outcome: "failed", latencyMs: value.totalLatencyMs, detail };
    } catch (cause) {
      return { model, outcome: "skipped", detail: cause instanceof Error ? cause.message : t("pws.completion.failed") };
    }
  }

  async function run() {
    if (models.length === 0 || flight.current || disableFlight.current || !gate.claim()) return;
    const controller = new AbortController();
    flight.current = controller;
    setRunning(true);
    setStopped(false);
    setRows([]);
    setNotice(null);
    setDisable({ kind: "idle" });
    try {
      if (!await confirmAction({
        message: t("pws.completion.allConfirm", { count: String(models.length), provider }),
        confirmLabel: t("pws.completion.runAll"), signal: controller.signal, locale,
      }) || controller.signal.aborted) return;
      // Sequential on purpose: the server admits one completion test per provider at a time.
      for (const model of models) {
        if (controller.signal.aborted) break;
        const row = await testOne(model, controller.signal);
        if (controller.signal.aborted) break;
        if ("stop" in row) { setNotice(row.stop); break; }
        setRows(previous => [...previous, row]);
      }
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        gate.release();
        setRunning(false);
      }
    }
  }

  function stop() {
    flight.current?.abort();
    flight.current = null;
    gate.release();
    setStopped(true);
    setRunning(false);
  }

  async function disableFailed() {
    const failed = failedModelIds(rows);
    if (failed.length === 0 || flight.current || disableFlight.current) return;
    const controller = new AbortController();
    disableFlight.current = controller;
    setDisable({ kind: "busy" });
    let confirmed = false;
    try {
      confirmed = await confirmAction({
        message: t("pws.completion.disableConfirm", { count: String(failed.length), provider }),
        confirmLabel: t("pws.completion.disableFailed", { count: String(failed.length) }),
        tone: "danger", locale, signal: controller.signal,
      });
      if (!confirmed || controller.signal.aborted || disableFlight.current !== controller) return;
      const response = await putModelVisibility(apiBase, "models", provider, failed.map(id => ({ id })), false, fetch, controller.signal);
      await readJsonOrThrow(response, t("pws.completion.disableError"));
      if (!controller.signal.aborted && disableFlight.current === controller) setDisable({ kind: "done", count: failed.length });
    } catch (cause) {
      if (!controller.signal.aborted && disableFlight.current === controller) {
        setDisable({ kind: "error", message: cause instanceof Error ? cause.message : t("pws.completion.disableError") });
      }
    } finally {
      if (disableFlight.current === controller) {
        disableFlight.current = null;
        if (!confirmed) setDisable({ kind: "idle" });
      }
    }
  }

  const counts = { ok: 0, failed: 0, skipped: 0 };
  for (const row of rows) counts[row.outcome]++;
  const failedCount = counts.failed;
  const skipped = counts.skipped + (running ? 0 : models.length - rows.length);

  return (
    <div className="pws-completion-bulk">
      <div className="row pws-completion-bulk-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={models.length === 0 || running || disable.kind === "busy" || blocked} onClick={() => void run()}>
          {running ? t("pws.completion.progress", { done: String(rows.length), total: String(models.length) }) : t("pws.completion.runAll")}
        </button>
        {running && <button type="button" className="btn btn-ghost btn-sm" onClick={stop}>{t("pws.completion.stop")}</button>}
      </div>
      {notice && <p role="status" className="muted pws-completion-result">{notice}</p>}
      {rows.length > 0 && (
        <div className="pws-completion-result" data-completion-bulk-state={running ? "running" : "done"}>
          {!running && <p role="status">
            {stopped && <>{t("pws.completion.stopped", { done: String(rows.length), total: String(models.length) })} · </>}
            {t("pws.completion.summary", { passed: String(counts.ok), failed: String(failedCount), skipped: String(skipped) })}
          </p>}
          <table className="pws-completion-table">
            <tbody>
              {rows.map(row => (
                <tr key={row.model} data-model-test-outcome={row.outcome}>
                  <td><code>{row.model}</code></td>
                  <td>
                    <span className={`badge ${row.outcome === "ok" ? "badge-green" : row.outcome === "failed" ? "badge-amber" : "badge-muted"}`}>
                      {t(row.outcome === "ok" ? "pws.completion.passed" : row.outcome === "failed" ? "pws.completion.failedShort" : "pws.completion.notTested")}
                    </span>
                  </td>
                  <td className="muted">{row.latencyMs !== undefined ? `${row.latencyMs} ms` : ""}</td>
                  <td className="muted">{row.detail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!running && failedCount > 0 && disable.kind !== "done" && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={disable.kind === "busy"} onClick={() => void disableFailed()}>
              {t("pws.completion.disableFailed", { count: String(failedCount) })}
            </button>
          )}
          {disable.kind === "done" && <p role="status" className="pws-status-ok">{t("pws.completion.disabledDone", { count: String(disable.count) })}</p>}
          {disable.kind === "error" && <p role="alert" className="pws-inline-error">{disable.message}</p>}
        </div>
      )}
    </div>
  );
}
