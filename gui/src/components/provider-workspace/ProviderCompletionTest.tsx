/** An explicitly consented, bounded completion probe; it never runs during discovery. */
import { useEffect, useRef, useState } from "react";
import { confirmAction } from "../../action-dialogs";
import { readJsonOrThrow } from "../../fetch-json";
import { useI18n, useT } from "../../i18n/shared";
import { Select } from "../../ui";
import ProviderBulkCompletionTest from "./ProviderBulkCompletionTest";
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
export type CompletionFailureRecovery = "aborted" | "concurrency" | "auth" | "rate_limit" | "connection" | "model" | "upstream";

/**
 * The server admits one completion test per provider at a time and answers an overlap with 409.
 * Both probes share this gate so neither control can start while the other is confirming or running.
 * Each probe gets a stable gate; whether the other probe holds it arrives as the `blocked` prop.
 */
export type ProbeGate = {
  claim(): boolean;
  release(): void;
};
type ProbeOwner = "single" | "bulk";

function createProbeGates(onChange: (owner: ProbeOwner | null) => void): Record<ProbeOwner, ProbeGate> {
  let holder: ProbeOwner | null = null;
  const gateFor = (owner: ProbeOwner): ProbeGate => ({
    claim() {
      if (holder !== null && holder !== owner) return false;
      holder = owner;
      onChange(owner);
      return true;
    },
    release() {
      if (holder !== owner) return;
      holder = null;
      onChange(null);
    },
  });
  return { single: gateFor("single"), bulk: gateFor("bulk") };
}

type Props = {
  apiBase: string;
  provider: string;
  models: string[];
  probeKey?: string;
  selectedModel?: string;
  onSelectedModelChange?: (model: string) => void;
  initialResult?: CompletionTestResult | null;
  initialError?: string | null;
  onStatusChange?: (state: {
    status: CompletionProbeStatus;
    model: string;
    result?: CompletionTestResult | null;
    error?: string | null;
  }) => void;
  onFixCredentials?: () => void;
  onFixSettings?: () => void;
  onFixModels?: () => void;
};

export default function ProviderCompletionTest({
  apiBase, provider, models, probeKey, selectedModel: controlledModel, onSelectedModelChange,
  initialResult = null, initialError = null, onStatusChange,
  onFixCredentials, onFixSettings, onFixModels,
}: Props) {
  const t = useT();
  const [internalModel, setInternalModel] = useState("");
  // Permanently clear a selected model that was removed from the list so re-adding it cannot
  // resurrect an older selection.
  if (controlledModel === undefined && internalModel !== "" && !models.includes(internalModel)) {
    setInternalModel("");
  }
  const rawModel = controlledModel !== undefined ? controlledModel : internalModel;
  const selectedModel = models.includes(rawModel) ? rawModel : "";
  const [active, setActive] = useState<ProbeOwner | null>(null);
  // Created once per mount; the holder lives in the closure, so render never reads it.
  const [gates] = useState(() => createProbeGates(setActive));
  return (
    <section className="pws-completion-test" aria-label={t("pws.completion.title")}>
      <h4 className="pws-section-title">{t("pws.completion.title")}</h4>
        <Select label={t("pws.completion.model")} value={selectedModel}
          options={[{ value: "", label: t("pws.completion.choose") }, ...models.map(value => ({ value, label: value }))]}
          onChange={next => {
            if (next === selectedModel) return;
            if (controlledModel === undefined) setInternalModel(next);
            onSelectedModelChange?.(next);
            onStatusChange?.({ status: "untested", model: next });
          }} />
        <CompletionRun key={JSON.stringify([apiBase, probeKey ?? "", provider, selectedModel])}
          apiBase={apiBase} provider={provider} model={selectedModel}
          initialResult={initialResult} initialError={initialError}
          onStatusChange={onStatusChange}
          onFixCredentials={onFixCredentials} onFixSettings={onFixSettings} onFixModels={onFixModels}
          gate={gates.single} blocked={active === "bulk"} />
        {/* Keyed by connection identity like the single run: a credential change remounts it, which
            aborts its requests and withdraws a disable consent given under the old credential. */}
        <ProviderBulkCompletionTest key={JSON.stringify([apiBase, probeKey ?? "", provider])}
          apiBase={apiBase} provider={provider} models={models}
          gate={gates.bulk} blocked={active === "single"} />
    </section>
  );
}

function CompletionRun({
  apiBase, provider, model, initialResult = null, initialError = null, onStatusChange,
  onFixCredentials, onFixSettings, onFixModels, gate, blocked,
}: Omit<Props, "models" | "probeKey" | "selectedModel" | "onSelectedModelChange"> & {
  model: string; gate: ProbeGate; blocked: boolean;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CompletionTestResult | null>(initialResult);
  const [error, setError] = useState<string | null>(initialError);
  const flight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (flight.current) {
        flight.current.abort();
        flight.current = null;
        gate.release();
      }
    };
  }, [gate]);

  async function run() {
    if (!model || flight.current || !gate.claim()) return;
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
          result: value,
          error: null,
        });
      }
    } catch (cause) {
      if (isCurrent()) {
        const message = cause instanceof Error ? cause.message : t("pws.completion.failed");
        setError(message);
        onStatusChange?.({ status: "failed", model, result: null, error: message });
      }
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        gate.release();
        if (mounted.current && !controller.signal.aborted) setBusy(false);
      }
    }
  }

  return <>
    <button type="button" className="btn btn-ghost btn-sm" disabled={!model || busy || blocked} onClick={() => void run()}>
      {busy ? t("pws.testing") : t("pws.completion.run")}
    </button>
    {error && <p role="alert" className="pws-inline-error pws-completion-result">{error}</p>}
    {error && (
      <div role="status" className="pws-completion-recovery pws-completion-result muted" data-failure-recovery="request">
        <span>{t("pws.completion.recovery.request", { model })}</span>
      </div>
    )}
    {result && (
      <CompletionResult
        result={result}
        onFixCredentials={onFixCredentials}
        onFixSettings={onFixSettings}
        onFixModels={onFixModels}
      />
    )}
  </>;
}

function classifyFailureRecovery(result: Extract<CompletionTestResult, { applicable: true }>): CompletionFailureRecovery | null {
  const err = result.error;
  if (result.ok || !err) return null;
  if (result.termination === "aborted" || err.code === "aborted") return "aborted";
  if (err.code === "credential_changed") return "concurrency";
  if (err.code === "credential_missing" || err.status === 401 || err.status === 403) return "auth";
  if (err.status === 429) return "rate_limit";
  if (
    result.termination === "timeout"
    || err.code === "timeout"
    || err.code === "network"
    || err.code === "destination_refused"
    || err.code === "redirect"
  ) {
    return "connection";
  }
  if (err.status === 400 || err.status === 404 || err.status === 422) return "model";
  return "upstream";
}

function CompletionResult({
  result, onFixCredentials, onFixSettings, onFixModels,
}: {
  result: CompletionTestResult;
  onFixCredentials?: () => void;
  onFixSettings?: () => void;
  onFixModels?: () => void;
}) {
  const t = useT();
  if (!result.applicable) return <div role="status" className="pws-completion-result muted">
    <p>{t("pws.completion.notApplicable")}: {t(`pws.completion.${result.reason}`)}</p>
    {result.detail && <p>{t(`pws.completion.${result.detail}`)}</p>}
    {result.adapter && <p><code>{result.adapter}</code></p>}
  </div>;
  const recovery = classifyFailureRecovery(result);
  const fixAuthAction = onFixCredentials ?? onFixSettings;
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
    {recovery && (
      <div className="pws-completion-recovery muted" data-failure-recovery={recovery}>
        <span>
          {recovery === "aborted"
            ? t("pws.completion.recovery.aborted", { model: result.requestedModel })
            : recovery === "concurrency"
              ? t("pws.completion.recovery.credentialChanged", { model: result.requestedModel })
              : recovery === "auth"
                ? t("pws.completion.recovery.auth", { model: result.requestedModel })
                : recovery === "rate_limit"
                  ? t("pws.completion.recovery.rateLimit", { model: result.requestedModel })
                  : recovery === "connection"
                    ? t("pws.completion.recovery.connection", { model: result.requestedModel })
                    : recovery === "model"
                      ? t("pws.completion.recovery.model")
                      : t("pws.completion.recovery.upstream", { model: result.requestedModel })}
        </span>
        {recovery === "auth" && fixAuthAction && (
          <button type="button" className="link-btn" data-recovery-action="fix-auth" onClick={fixAuthAction}>
            {t("pws.completion.recovery.fixAuth")}
          </button>
        )}
        {recovery === "rate_limit" && fixAuthAction && (
          <button type="button" className="link-btn" data-recovery-action="fix-rate-limit" onClick={fixAuthAction}>
            {t("pws.completion.recovery.fixAuth")}
          </button>
        )}
        {recovery === "connection" && onFixSettings && (
          <button type="button" className="link-btn" data-recovery-action="fix-connection" onClick={onFixSettings}>
            {t("pws.completion.recovery.fixSettings")}
          </button>
        )}
        {recovery === "model" && onFixModels && (
          <button type="button" className="link-btn" data-recovery-action="fix-model" onClick={onFixModels}>
            {t("pws.firstResponse.openProviderModels")}
          </button>
        )}
        {recovery === "upstream" && onFixSettings && (
          <button type="button" className="link-btn" data-recovery-action="fix-settings" onClick={onFixSettings}>
            {t("pws.completion.recovery.fixSettings")}
          </button>
        )}
      </div>
    )}
  </div>;
}
