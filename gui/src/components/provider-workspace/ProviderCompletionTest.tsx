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

type Props = { apiBase: string; provider: string; models: string[] };

export default function ProviderCompletionTest({ apiBase, provider, models }: Props) {
  const t = useT();
  const [model, setModel] = useState("");
  const selectedModel = models.includes(model) ? model : "";
  return (
    <section className="pws-completion-test" aria-label={t("pws.completion.title")}>
      <h4 className="pws-section-title">{t("pws.completion.title")}</h4>
        <Select label={t("pws.completion.model")} value={selectedModel}
          options={[{ value: "", label: t("pws.completion.choose") }, ...models.map(value => ({ value, label: value }))]}
          onChange={setModel} />
        <CompletionRun key={JSON.stringify([apiBase, provider, selectedModel])}
          apiBase={apiBase} provider={provider} model={selectedModel} />
    </section>
  );
}

function CompletionRun({ apiBase, provider, model }: Omit<Props, "models"> & { model: string }) {
  const t = useT();
  const { locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CompletionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef<AbortController | null>(null);
  useEffect(() => () => { flight.current?.abort(); flight.current = null; }, []);

  async function run() {
    if (!model || flight.current) return;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      if (!await confirmAction({ message: t("pws.completion.confirm", { model, provider }),
        confirmLabel: t("pws.completion.run"), signal: controller.signal, locale }) || controller.signal.aborted) return;
      // The dashboard's installed fetch wrapper supplies session and CSRF headers, as for the connection test.
      const response = await fetch(`${apiBase}/api/providers/test-completion?name=${encodeURIComponent(provider)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, confirm: true }), signal: controller.signal,
      });
      const value = await readJsonOrThrow<CompletionTestResult>(response, t("pws.completion.failed"));
      if (!value) throw new Error(t("pws.completion.failed"));
      if (!controller.signal.aborted) setResult(value);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("pws.completion.failed"));
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        if (!controller.signal.aborted) setBusy(false);
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
