/** An explicitly consented, bounded completion probe; it never runs during discovery. */
import { useEffect, useRef, useState } from "react";
import { confirmAction } from "../../action-dialogs";
import { readJsonOrThrow } from "../../fetch-json";
import { useI18n, useT } from "../../i18n/shared";
import { Select } from "../../ui";
import "./provider-completion-test.css";

type InapplicableReason = "disabled" | "forward_auth" | "oauth_auth" | "unsupported_adapter" | "unsupported_transport";
type TransportDetail = "tls_profile" | "upstream_http_version" | "request_pacing" | "custom_executor_egress";
export type CompletionTestResult =
  | { applicable: false; reason: InapplicableReason; adapter?: string; detail?: TransportDetail }
  | { applicable: true; ok: boolean; provider: string; requestedModel: string; wireModel: string;
      wire: "openai-chat" | "openai-responses"; upstreamModel: string | null;
      modelComparison: "match" | "mismatch" | "unknown";
      comparisonNote?: "missing_metadata" | "conflicting_metadata"; identityVerified: false;
      ttftMs: number | null; totalLatencyMs: number; outputTokenCap: 32;
      termination: "completed" | "failed" | "timeout" | "aborted" | "too_large";
      error: { code: string; status?: number; message: string } | null };

export type CompletionProbeStatus = "untested" | "testing" | "ok" | "failed" | "not-applicable";

type Props = {
  apiBase: string;
  provider: string;
  models: string[];
  onStatusChange?: (state: { status: CompletionProbeStatus; model: string }) => void;
};

export default function ProviderCompletionTest({ apiBase, provider, models, onStatusChange }: Props) {
  const t = useT();
  const [model, setModel] = useState("");
  // Permanently clear a selected model that was removed from the list so re-adding it cannot
  // resurrect an older selection.
  if (model !== "" && !models.includes(model)) {
    setModel("");
  }
  const selectedModel = models.includes(model) ? model : "";
  return (
    <section className="pws-completion-test" aria-label={t("pws.completion.title")}>
      <h4 className="pws-section-title">{t("pws.completion.title")}</h4>
        <Select label={t("pws.completion.model")} value={selectedModel}
          options={[{ value: "", label: t("pws.completion.choose") }, ...models.map(value => ({ value, label: value }))]}
          onChange={next => {
            if (next === selectedModel) return;
            setModel(next);
            onStatusChange?.({ status: "untested", model: next });
          }} />
        <CompletionRun key={JSON.stringify([apiBase, provider, selectedModel])}
          apiBase={apiBase} provider={provider} model={selectedModel} onStatusChange={onStatusChange} />
    </section>
  );
}

function CompletionRun({ apiBase, provider, model, onStatusChange }: Omit<Props, "models"> & { model: string }) {
  const t = useT();
  const { locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CompletionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
      flight.current = null;
    };
  }, []);

  async function run() {
    if (!model || flight.current) return;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    const isCurrent = () => mounted.current && !controller.signal.aborted && flight.current === controller;
    try {
      const confirmed = await confirmAction({
        message: t("pws.completion.confirm", { model, provider }),
        confirmLabel: t("pws.completion.run"),
        signal: controller.signal,
        locale,
      });
      if (!isCurrent()) return;
      if (!confirmed) return;
      setResult(null);
      setError(null);
      onStatusChange?.({ status: "testing", model });
      // The dashboard's installed fetch wrapper supplies session and CSRF headers, as for the connection test.
      const response = await fetch(`${apiBase}/api/providers/test-completion?name=${encodeURIComponent(provider)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, confirm: true }), signal: controller.signal,
      });
      const value = await readJsonOrThrow<CompletionTestResult>(response, t("pws.completion.failed"));
      if (!value) throw new Error(t("pws.completion.failed"));
      if (isCurrent()) {
        setResult(value);
        onStatusChange?.({
          status: !value.applicable ? "not-applicable" : value.ok ? "ok" : "failed",
          model,
        });
      }
    } catch (cause) {
      if (isCurrent()) {
        setError(cause instanceof Error ? cause.message : t("pws.completion.failed"));
        onStatusChange?.({ status: "failed", model });
      }
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        if (mounted.current && !controller.signal.aborted) setBusy(false);
      }
    }
  }

  return <>
    <button type="button" className="btn btn-ghost btn-sm" disabled={!model || busy} onClick={() => void run()}>
      {busy ? t("pws.testing") : t("pws.completion.run")}
    </button>
    {error && <p role="alert" className="pws-inline-error pws-completion-result">{error}</p>}
    {result && <CompletionResult result={result} />}
  </>;
}

function CompletionResult({ result }: { result: CompletionTestResult }) {
  const t = useT();
  if (!result.applicable) return <div role="status" className="pws-completion-result muted">
    <p>{t("pws.completion.notApplicable")}: {t(`pws.completion.${result.reason}`)}</p>
    {result.detail && <p>{t(`pws.completion.${result.detail}`)}</p>}
    {result.adapter && <p><code>{result.adapter}</code></p>}
  </div>;
  return <div role="status" className="pws-completion-result" data-completion-test-state={result.ok ? "ok" : "failed"}>
    <p className={result.ok ? "pws-status-ok" : "pws-status-warn"}>
      {t(result.ok ? "pws.completion.ok" : "pws.completion.failed")}
    </p>
    <dl className="pws-kv">
      <div className="pws-kv-row"><dt>{t("pws.completion.ttft")}</dt><dd>{result.ttftMs === null ? "—" : `${result.ttftMs} ms`}</dd></div>
      <div className="pws-kv-row"><dt>{t("pws.completion.total")}</dt><dd>{result.totalLatencyMs} ms</dd></div>
    </dl>
    <p>{result.upstreamModel === null ? t("pws.completion.unreported", { model: result.wireModel })
      : t("pws.completion.reported", { upstream: result.upstreamModel, model: result.wireModel })}</p>
    <span className={`badge ${result.modelComparison === "match" ? "badge-green" : result.modelComparison === "mismatch" ? "badge-amber" : "badge-muted"}`}>
      {t(`pws.completion.${result.modelComparison}`)}
    </span>
    {result.comparisonNote && <p className="muted">{t(`pws.completion.${result.comparisonNote}`)}</p>}
    <p className="muted">{t("pws.completion.identity")}</p>
    {result.error && <p role="alert" className="pws-inline-error"><code>{result.error.code}</code>
      {result.error.status !== undefined && <> ({result.error.status})</>}: {result.error.message}</p>}
  </div>;
}
