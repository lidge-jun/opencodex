import { useEffect, useRef, useState } from "react";
import { EmptyState, Notice, Switch } from "../../ui";
import { useT } from "../../i18n/shared";
import { testGuardrailsText } from "./guardrails-api";
import {
  GUARDRAILS_DATA_TYPES,
  GUARDRAILS_DATA_TYPE_KEYS,
} from "./constants";
import type {
  GuardrailsDataType,
  GuardrailsTesterResult,
  GuardrailsTrafficProtection,
} from "./types";

const MAX_TEST_BYTES = 128 * 1024;

export function GuardrailsTesterPanel({
  apiBase,
  trafficProtection,
}: {
  apiBase: string;
  trafficProtection?: GuardrailsTrafficProtection;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [result, setResult] = useState<GuardrailsTesterResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [useDraft, setUseDraft] = useState(false);
  const [draftDataTypes, setDraftDataTypes] = useState<GuardrailsDataType[]>([...GUARDRAILS_DATA_TYPES]);
  const [draftKeywordPrefilter, setDraftKeywordPrefilter] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const bytes = new TextEncoder().encode(text).byteLength;
  const actualTrafficProtection: GuardrailsTrafficProtection =
    trafficProtection ?? result?.trafficProtection ?? "unknown";

  useEffect(() => () => requestRef.current?.abort(), []);

  const invalidate = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    setPending(false);
    setResult(null);
    setError(null);
  };

  const scan = async () => {
    if (pending || bytes > MAX_TEST_BYTES || text.length === 0) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(true);
    setError(null);
    try {
      const next = await testGuardrailsText(
        apiBase,
        text,
        controller.signal,
        t("guardrails.testerFailed"),
        useDraft
          ? {
              enabled: true,
              enabledDataTypes: draftDataTypes,
              keywordPrefilterEnabled: draftKeywordPrefilter,
            }
          : undefined,
      );
      if (!controller.signal.aborted) setResult(next);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : t("guardrails.testerFailed"));
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setPending(false);
      }
    }
  };

  const clear = () => {
    invalidate();
    setText("");
  };

  return (
    <div className="guardrails-panel-stack">
      <Notice tone="warn">{t("guardrails.testerSimulation")}</Notice>
      {actualTrafficProtection === "disabled" && (
        <Notice tone="warn">{t("guardrails.testerTrafficDisabled")}</Notice>
      )}
      {actualTrafficProtection === "detect" && (
        <Notice tone="warn">{t("guardrails.testerTrafficDetect")}</Notice>
      )}
      {actualTrafficProtection === "unknown" && (
        <Notice tone="warn">{t("guardrails.testerTrafficUnknown")}</Notice>
      )}
      {actualTrafficProtection === "unavailable" && (
        <Notice tone="warn">{t("guardrails.testerTrafficUnavailable")}</Notice>
      )}
      {actualTrafficProtection === "no-rules" && (
        <Notice tone="warn">{t("guardrails.testerTrafficNoRules")}</Notice>
      )}
      {actualTrafficProtection === "no-provider-coverage" && (
        <Notice tone="warn">{t("guardrails.testerTrafficNoProviderCoverage")}</Notice>
      )}
      {actualTrafficProtection === "reduced" && (
        <Notice tone="warn">{t("guardrails.testerTrafficReduced")}</Notice>
      )}
      <section className="card guardrails-tester-card">
        <div className="card-head"><strong>{t("guardrails.testerTitle")}</strong></div>
        <p className="card-sub">{t("guardrails.testerHint")}</p>
        <div className="guardrails-switch-row guardrails-tester-draft-toggle">
          <div>
            <strong>{t("guardrails.testerDraftSettings")}</strong>
            <p>{t("guardrails.testerDraftSettingsHint")}</p>
          </div>
          <Switch
            on={useDraft}
            disabled={pending}
            label={t("guardrails.testerDraftSettings")}
            onClick={() => {
              invalidate();
              setUseDraft(value => !value);
            }}
          />
        </div>
        {useDraft && (
          <div className="guardrails-tester-draft">
            <fieldset className="guardrails-types">
              <legend>{t("guardrails.dataTypes")}</legend>
              {GUARDRAILS_DATA_TYPES.map(dataType => (
                <label key={dataType}>
                  <input
                    type="checkbox"
                    checked={draftDataTypes.includes(dataType)}
                    disabled={pending}
                    onChange={() => {
                      const next = draftDataTypes.includes(dataType)
                        ? draftDataTypes.filter(value => value !== dataType)
                        : [...draftDataTypes, dataType].sort();
                      if (next.length === 0) return;
                      invalidate();
                      setDraftDataTypes(next);
                    }}
                  />
                  {t(GUARDRAILS_DATA_TYPE_KEYS[dataType])}
                </label>
              ))}
            </fieldset>
            <div className="guardrails-switch-row">
              <div>
                <strong>{t("guardrails.keywordPrefilter")}</strong>
                <p>{t("guardrails.keywordPrefilterHint")}</p>
              </div>
              <Switch
                on={draftKeywordPrefilter}
                disabled={pending}
                label={t("guardrails.keywordPrefilter")}
                onClick={() => {
                  invalidate();
                  setDraftKeywordPrefilter(value => !value);
                }}
              />
            </div>
          </div>
        )}
        <label className="guardrails-textarea-field">
          <span className="field-label">{t("guardrails.testerInput")}</span>
          <textarea
            value={text}
            disabled={pending}
            onChange={event => {
              invalidate();
              setText(event.target.value);
            }}
            placeholder={t("guardrails.testerPlaceholder")}
          />
        </label>
        <div className="guardrails-tester-actions">
          <span className={bytes > MAX_TEST_BYTES ? "guardrails-byte-over" : "muted"}>
            {t("guardrails.byteCounter", { current: bytes, max: MAX_TEST_BYTES })}
          </span>
          <div>
            <button type="button" className="btn btn-ghost" onClick={clear} disabled={pending && text.length === 0}>
              {t("guardrails.clear")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending || text.length === 0 || bytes > MAX_TEST_BYTES}
              onClick={() => void scan()}
            >
              {pending ? t("guardrails.testing") : t("guardrails.test")}
            </button>
          </div>
        </div>
      </section>
      {error && <Notice tone="err">{error}</Notice>}
      {result && (
        <section className="card">
          <div className="card-head">
            <strong>{t("guardrails.testerResult")}</strong>
            <span className="badge badge-muted">{t(result.mode === "draft" ? "guardrails.draft" : "guardrails.effective")}</span>
          </div>
          <pre className="guardrails-masked-preview"><code>{result.maskedPreview}</code></pre>
          {result.findings.length === 0
            ? <EmptyState title={t("guardrails.noFindings")} />
            : (
              <>
                <p className="guardrails-table-scroll-hint">{t("guardrails.tableScrollHint")}</p>
                <div className="guardrails-wide-table" role="region" tabIndex={0} aria-label={t("guardrails.findings")}>
                  <table>
                    <thead><tr>
                      <th>{t("guardrails.ruleId")}</th>
                      <th>{t("guardrails.placeholder")}</th>
                      <th>{t("guardrails.offsets")}</th>
                    </tr></thead>
                    <tbody>{result.findings.map(finding => (
                      <tr key={`${finding.ruleId}-${finding.start}-${finding.end}-${finding.placeholder ?? ""}`}>
                        <td><code>{finding.ruleId}</code></td>
                        <td><code>{finding.placeholder ?? "—"}</code></td>
                        <td>{finding.start}–{finding.end}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </>
            )}
        </section>
      )}
    </div>
  );
}
