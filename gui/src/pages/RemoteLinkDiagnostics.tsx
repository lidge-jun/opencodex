import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "@/components/ui-v2/button";
import { Banner } from "../components/v2-startup/primitives";
import { IconRefresh } from "../icons";
import { useI18n } from "../i18n/shared";
import { fetchLinkDiagnostics, type LinkDiagnosticView, type LinkDiagnosticsView } from "../remote-link-diagnostics-api";

const MISSING = <span className="text-fg-subtle">—</span>;

type DiagnosticsState = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; view: LinkDiagnosticsView } | { kind: "error" };

const dateFormats = new Map<string, Intl.DateTimeFormat>();
function formatTime(locale: string, timestamp: number): string {
  let format = dateFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" });
    dateFormats.set(locale, format);
  }
  return format.format(new Date(timestamp));
}

function stateText(record: LinkDiagnosticView): string | null {
  if (record.previousState && record.state) return record.previousState + " → " + record.state;
  return record.state ?? null;
}

/**
 * Read-only view of this runtime's bounded link diagnostics (GET /api/link/diagnostics). It loads
 * only when opened, so the Remote Link page makes no extra request until an operator asks for it.
 */
export function RemoteLinkDiagnostics({ apiBase }: { apiBase: string }): ReactElement {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DiagnosticsState>({ kind: "idle" });
  const requestRef = useRef<{ controller: AbortController; sequence: number } | null>(null);
  const sequenceRef = useRef(0);

  const load = useCallback(async () => {
    requestRef.current?.controller.abort();
    const request = { controller: new AbortController(), sequence: ++sequenceRef.current };
    requestRef.current = request;
    setState({ kind: "loading" });
    try {
      const view = await fetchLinkDiagnostics(apiBase, request.controller.signal);
      if (requestRef.current === request) setState({ kind: "ready", view });
    } catch {
      if (requestRef.current === request) setState({ kind: "error" });
    }
  }, [apiBase]);

  useEffect(() => () => { requestRef.current?.controller.abort(); requestRef.current = null; }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && state.kind === "idle") void load();
  };

  return (
    <section className="remote-link-panel flex min-w-0 flex-col rounded-[12px] bg-surface p-1 ring-1 ring-line" aria-labelledby="remote-link-diagnostics-title">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 id="remote-link-diagnostics-title" className="m-0 text-[15px] leading-6 font-semibold tracking-[-0.01em]">{t("remoteLinkDiagnostics.title")}</h3>
          <span className="text-[13px] leading-5 text-fg-muted">{t("remoteLinkDiagnostics.hint")}</span>
        </div>
        {open && (
          <Button variant="ghost" size="sm" data-action="link-diagnostics-refresh" onClick={() => void load()} disabled={state.kind === "loading"}>
            <IconRefresh />{t("link.refresh")}
          </Button>
        )}
        <Button variant="outline" size="sm" data-action="link-diagnostics-toggle" aria-expanded={open} aria-controls="remote-link-diagnostics-body" onClick={toggle}>
          {open ? t("remoteLinkDiagnostics.hide") : t("remoteLinkDiagnostics.show")}
        </Button>
      </div>
      {open && (
        <div id="remote-link-diagnostics-body" className="flex min-w-0 flex-col gap-2 rounded-[8px] bg-bg p-3 ring-1 ring-line" aria-live="polite">
          {state.kind === "loading" && <p data-state="loading" className="m-0 text-[13px] text-fg-muted">{t("remoteLinkDiagnostics.loading")}</p>}
          {state.kind === "error" && <div data-state="error"><Banner tone="err">{t("remoteLinkDiagnostics.error")}</Banner></div>}
          {state.kind === "ready" && state.view.records.length === 0 && (
            <p data-state="empty" className="m-0 px-1 py-3 text-center text-[13px] text-fg-muted">{t("remoteLinkDiagnostics.empty")}</p>
          )}
          {state.kind === "ready" && state.view.records.length > 0 && (
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full border-collapse text-left text-[12px] leading-5">
                <thead className="text-fg-muted">
                  <tr>
                    <th scope="col" className="px-2 py-1 font-medium">{t("remoteLinkDiagnostics.colTime")}</th>
                    <th scope="col" className="px-2 py-1 font-medium">{t("remoteLinkDiagnostics.colEvent")}</th>
                    <th scope="col" className="px-2 py-1 font-medium">{t("remoteLinkDiagnostics.colOutcome")}</th>
                    <th scope="col" className="px-2 py-1 font-medium">{t("remoteLinkDiagnostics.colState")}</th>
                    <th scope="col" className="px-2 py-1 text-right font-medium">{t("remoteLinkDiagnostics.colAttempt")}</th>
                    <th scope="col" className="px-2 py-1 text-right font-medium">{t("remoteLinkDiagnostics.colPort")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {state.view.records.map(record => {
                    const transition = stateText(record);
                    return (
                      <tr key={record.rowKey}>
                        <td className="whitespace-nowrap px-2 py-1 tabular-nums">{record.timestamp !== undefined ? formatTime(locale, record.timestamp) : MISSING}</td>
                        <td className="px-2 py-1"><code className="font-mono">{record.event}</code></td>
                        <td className="px-2 py-1">
                          <code className="font-mono">{record.outcome}</code>
                          {record.suppressed !== undefined && <span className="ml-2 text-fg-muted">{t("remoteLinkDiagnostics.suppressed", { count: record.suppressed })}</span>}
                        </td>
                        <td className="px-2 py-1">{transition ? <code className="font-mono">{transition}</code> : MISSING}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{record.attempt ?? MISSING}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{record.tunnelPort ?? MISSING}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {state.kind === "ready" && (
            <div className="flex flex-col gap-0.5 px-1 text-[12px] leading-5 text-fg-muted">
              {state.view.records.length > 0 && <span>{t("remoteLinkDiagnostics.showing", { shown: state.view.records.length, total: state.view.matched })}</span>}
              {state.view.skipped > 0 && <span>{t("remoteLinkDiagnostics.skipped", { count: state.view.skipped })}</span>}
              {state.view.truncated && <span>{t("remoteLinkDiagnostics.truncated")}</span>}
              {state.view.refused && <span>{t("remoteLinkDiagnostics.refused")}</span>}
              {state.view.unreadable && <span>{t("remoteLinkDiagnostics.unreadable")}</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
