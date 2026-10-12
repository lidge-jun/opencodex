import { useEffect, useMemo, useRef, useState } from "react";
import { JEV_DECISION_ISSUE_LABEL_KEYS, jevDecisionServiceOptions } from "../combo-workspace-data";
import { type TKey, useT } from "../i18n/shared";
import {
  JEV_BACKEND_LABEL_KEYS,
  JEV_DECISION_TIMEOUT_DEFAULT_MS,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
  type JevDecisionMethod,
  jevDecisionMethod,
  jevDecisionModelOptions,
} from "../jev-decision-service";
import type { ModelOption, ProviderOption } from "./combo-workspace-types";

export type JevDecisionPatch = {
  decisionProvider?: string | null;
  decisionModel?: string | null;
  decisionTimeoutMs?: number | null;
};

type DecisionTestResult =
  | { state: "running" }
  | { state: "done"; ok: boolean; backend: string; gate: string; latencyMs: number }
  | { state: "error"; message: string };

const METHODS: readonly JevDecisionMethod[] = ["typesafe", "systemone", "model"];

const METHOD_LABEL_KEYS: Record<JevDecisionMethod, TKey> = {
  typesafe: "cws.jev.method.typesafe",
  systemone: "cws.jev.method.systemone",
  model: "cws.jev.method.model",
};

/**
 * "Decision method" for a JEV combo: TypeSafe, a System One-compatible server, or any model
 * opencodex routes. Callers render it only for `strategy: "jev"`. The Test button probes the
 * unsaved selection through POST /api/combos/decision-test; nothing is written.
 */
export function ComboJevDecisionSection({
  idPrefix,
  apiBase,
  combo,
  combos,
  providers,
  models,
  decisionProvider,
  decisionModel,
  decisionTimeoutMs,
  disabled,
  onChange,
}: {
  idPrefix: string;
  apiBase?: string;
  /** The combo being edited; excluded from the model list together with every JEV combo. */
  combo: { id: string; alias?: string | null; model?: string };
  combos: readonly { id: string; alias?: string | null; model: string; strategy: string }[];
  providers: ProviderOption[];
  models: ModelOption[];
  decisionProvider: string | null;
  decisionModel: string | null;
  decisionTimeoutMs: number | null;
  disabled?: boolean;
  onChange: (patch: JevDecisionPatch) => void;
}) {
  const t = useT();
  const method = jevDecisionMethod({ decisionProvider, decisionModel });
  const servers = useMemo(
    () => jevDecisionServiceOptions(providers, decisionProvider).filter(option => option.id !== null),
    [providers, decisionProvider],
  );
  const selectedServer = servers.find(option => option.id === decisionProvider?.trim());
  // The parent passes the whole draft, which changes identity on every keystroke; only its
  // identity fields affect the route list.
  const { id: comboId, alias: comboAlias, model: comboModel } = combo;
  const modelRoutes = useMemo(
    () => jevDecisionModelOptions(models, providers, combos, { id: comboId, alias: comboAlias, model: comboModel }),
    [models, providers, combos, comboId, comboAlias, comboModel],
  );
  // Each result remembers the selection it describes; a different selection shows no result.
  const [probe, setProbe] = useState<{ key: string; result: DecisionTestResult } | null>(null);
  const testAbort = useRef<AbortController | null>(null);
  const selectionKey = `${method}\0${decisionProvider ?? ""}\0${decisionModel ?? ""}\0${decisionTimeoutMs ?? ""}`;
  const test = probe?.key === selectionKey ? probe.result : null;
  // Concatenated, not a template: the i18n lint reads template text outside JSX id props as copy.
  const modelListId = idPrefix + "-decision-model-options";

  // Changing the selection (or unmounting) cancels an in-flight probe for the old one.
  useEffect(() => () => {
    testAbort.current?.abort();
    testAbort.current = null;
  }, [selectionKey]);

  const selectMethod = (next: JevDecisionMethod) => {
    if (next === method) return;
    if (next === "typesafe") onChange({ decisionProvider: null, decisionModel: null });
    else if (next === "systemone") {
      const first = servers.find(option => !option.issue)?.id ?? servers[0]?.id ?? "";
      onChange({ decisionProvider: first, decisionModel: null });
    } else onChange({ decisionProvider: null, decisionModel: modelRoutes[0] ?? "" });
  };

  const canTest = method === "typesafe"
    || (method === "systemone" && !!selectedServer && !selectedServer.issue)
    || (method === "model" && !!decisionModel?.trim());

  const runTest = async () => {
    testAbort.current?.abort();
    const controller = new AbortController();
    testAbort.current = controller;
    const key = selectionKey;
    const setTest = (result: DecisionTestResult) => setProbe({ key, result });
    setTest({ state: "running" });
    try {
      const response = await fetch(`${apiBase ?? ""}/api/combos/decision-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...(combo.id.trim() ? { comboId: combo.id.trim() } : {}),
          ...(method === "systemone" && decisionProvider ? { decisionProvider: decisionProvider.trim() } : {}),
          ...(method === "model" && decisionModel ? { decisionModel: decisionModel.trim() } : {}),
          ...(decisionTimeoutMs !== null ? { decisionTimeoutMs } : {}),
        }),
      });
      if (!response.ok) {
        // The management API reports refusals as { error }; anything else falls back to the status.
        const failure = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (controller.signal.aborted) return;
        setTest({ state: "error", message: failure && typeof failure.error === "string" ? failure.error : String(response.status) });
        return;
      }
      const data = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (controller.signal.aborted) return;
      if (!data || typeof data.gate !== "string") {
        setTest({ state: "error", message: String(response.status) });
        return;
      }
      setTest({
        state: "done",
        ok: data.ok === true,
        backend: typeof data.backend === "string" ? data.backend : "unknown",
        gate: data.gate,
        latencyMs: typeof data.latencyMs === "number" ? Math.round(data.latencyMs) : 0,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setTest({ state: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (testAbort.current === controller) testAbort.current = null;
    }
  };

  return (
    <fieldset className="cwi-field cwi-jev-decision" aria-describedby={`${idPrefix}-decision-method-hint`}>
      <legend className="field-label">{t("cws.jev.decisionMethod")}</legend>
      <div className="segmented" role="group" aria-label={t("cws.jev.decisionMethod")}>
        {METHODS.map(option => (
          <button
            key={option}
            type="button"
            id={`${idPrefix}-decision-method-${option}`}
            className={`btn btn-sm ${method === option ? "btn-primary" : "btn-ghost"}`}
            aria-pressed={method === option}
            disabled={disabled}
            onClick={() => selectMethod(option)}
          >
            {t(METHOD_LABEL_KEYS[option])}
          </button>
        ))}
      </div>
      <p id={`${idPrefix}-decision-method-hint`} className="muted" style={{ fontSize: 12, margin: "8px 0 0", overflowWrap: "anywhere" }}>
        {method === "typesafe" && t("cws.jev.decisionServiceDefaultHint")}
        {method === "systemone" && servers.length === 0 && t("cws.jev.method.systemoneEmpty")}
      </p>

      {method === "systemone" && servers.length > 0 && (
        <div className="cwi-field" style={{ marginTop: 8 }}>
          <label htmlFor={`${idPrefix}-decision-provider`}>{t("cws.jev.decisionService")}</label>
          <select
            id={`${idPrefix}-decision-provider`}
            className="input"
            value={decisionProvider?.trim() ?? ""}
            disabled={disabled}
            aria-describedby={selectedServer?.issue
              ? `${idPrefix}-decision-provider-hint ${idPrefix}-decision-provider-issue`
              : `${idPrefix}-decision-provider-hint`}
            aria-invalid={selectedServer?.issue ? true : undefined}
            onChange={(e) => onChange({ decisionProvider: e.target.value, decisionModel: null })}
          >
            {!selectedServer && <option value="" disabled>—</option>}
            {servers.map(option => (
              // An unusable row stays visible with its reason; only the stored one stays selectable.
              <option
                key={option.id!}
                value={option.id!}
                disabled={option.issue !== undefined && option.id !== selectedServer?.id}
              >
                {option.issue ? `${option.id} (${t(JEV_DECISION_ISSUE_LABEL_KEYS[option.issue])})` : option.id}
              </option>
            ))}
          </select>
          <p id={`${idPrefix}-decision-provider-hint`} className="muted" style={{ fontSize: 12, margin: "8px 0 0", overflowWrap: "anywhere" }}>
            {t("cws.jev.decisionServiceHint")}
            {selectedServer?.baseUrl && <> <code>{selectedServer.baseUrl}</code></>}
          </p>
          {selectedServer?.issue && (
            <p id={`${idPrefix}-decision-provider-issue`} className="muted" style={{ fontSize: 12, margin: "4px 0 0", color: "var(--danger, #b42318)" }}>
              {t("cws.err.invalidDecisionProvider", {
                name: selectedServer.id ?? "",
                reason: t(JEV_DECISION_ISSUE_LABEL_KEYS[selectedServer.issue]),
              })}
            </p>
          )}
        </div>
      )}

      {method === "model" && (
        <div className="cwi-field" style={{ marginTop: 8 }}>
          <label htmlFor={`${idPrefix}-decision-model`}>{t("cws.jev.decisionModel")}</label>
          <input
            id={`${idPrefix}-decision-model`}
            className="input mono"
            list={modelListId}
            value={decisionModel ?? ""}
            maxLength={512}
            spellCheck={false}
            autoComplete="off"
            placeholder="ollama/qwen3:4b"
            disabled={disabled}
            aria-describedby={`${idPrefix}-decision-model-hint`}
            onChange={(e) => onChange({ decisionModel: e.target.value, decisionProvider: null })}
          />
          <datalist id={modelListId}>
            {modelRoutes.map(route => <option key={route} value={route} />)}
          </datalist>
          <p id={`${idPrefix}-decision-model-hint`} className="muted" style={{ fontSize: 12, margin: "8px 0 0", overflowWrap: "anywhere" }}>
            {t("cws.jev.decisionModelHint")}
          </p>
        </div>
      )}

      <div className="cwi-field" style={{ marginTop: 8 }}>
        <label htmlFor={`${idPrefix}-decision-timeout`}>{t("cws.jev.decisionTimeout")}</label>
        <input
          id={`${idPrefix}-decision-timeout`}
          className="input mono"
          type="number"
          inputMode="numeric"
          min={JEV_DECISION_TIMEOUT_MIN_MS}
          max={JEV_DECISION_TIMEOUT_MAX_MS}
          step={1}
          placeholder={String(JEV_DECISION_TIMEOUT_DEFAULT_MS)}
          value={decisionTimeoutMs ?? ""}
          disabled={disabled}
          aria-describedby={`${idPrefix}-decision-timeout-hint`}
          onChange={(e) => {
            if (e.target.value === "") {
              onChange({ decisionTimeoutMs: null });
              return;
            }
            const value = Number(e.target.value);
            if (Number.isFinite(value)) onChange({ decisionTimeoutMs: value });
          }}
        />
        <p id={`${idPrefix}-decision-timeout-hint`} className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
          {t("cws.jev.decisionTimeoutHint", {
            default: JEV_DECISION_TIMEOUT_DEFAULT_MS,
            min: JEV_DECISION_TIMEOUT_MIN_MS,
            max: JEV_DECISION_TIMEOUT_MAX_MS,
          })}
        </p>
      </div>

      <div className="cwi-jev-decision-test" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={disabled || !canTest || test?.state === "running"}
          onClick={() => { void runTest(); }}
        >
          {test?.state === "running" ? t("cws.jev.testing") : t("cws.jev.test")}
        </button>
        <span className="muted" role="status" aria-live="polite" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
          {test === null && t("cws.jev.testHint")}
          {test?.state === "done" && (test.ok
            ? t("cws.jev.testOk", { ms: test.latencyMs, backend: t(JEV_BACKEND_LABEL_KEYS[test.backend] ?? "cws.jev.backend.unknown") })
            : t("cws.jev.testFailOpen", { gate: test.gate, ms: test.latencyMs }))}
          {test?.state === "error" && t("cws.jev.testError", { error: test.message })}
        </span>
      </div>
    </fieldset>
  );
}
