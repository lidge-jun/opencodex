import { useState } from "react";
import { Notice, Select, Switch } from "../../ui";
import { useT } from "../../i18n/shared";
import {
  GUARDRAILS_DATA_TYPES,
  GUARDRAILS_DATA_TYPE_KEYS,
} from "./constants";
import type {
  GuardrailsFailurePolicy,
  GuardrailsMode,
  GuardrailsSettings,
  GuardrailsSettingsPatch,
} from "./types";

export function GuardrailsSettingsPanel({
  settings,
  pending,
  onSettings,
}: {
  settings: GuardrailsSettings;
  pending: boolean;
  onSettings: (
    patch: GuardrailsSettingsPatch,
    consequence?: "disable" | "detect" | "passthrough" | "disableCategory" | "limitProvider",
  ) => void;
}) {
  const t = useT();
  const enabledDataTypesFingerprint = settings.enabledDataTypes.join(",");
  const [coverageErrorFor, setCoverageErrorFor] = useState<string | null>(null);
  const coverageError = coverageErrorFor === enabledDataTypesFingerprint;
  const providerIds = settings.providerOptions.map(provider => provider.id);
  const selectedProviderIds = settings.providerScope.mode === "all"
    ? providerIds
    : settings.providerScope.providerIds;
  const providerFingerprint = selectedProviderIds.join(",");
  const [providerErrorFor, setProviderErrorFor] = useState<string | null>(null);
  const providerError = providerErrorFor === providerFingerprint;
  const reducedCoverage = settings.enabledDataTypes.length < GUARDRAILS_DATA_TYPES.length
    || settings.disabledBuiltinRuleIds.length > 0
    || settings.failurePolicy === "passthrough"
    || settings.providerScope.mode === "selected";
  const noProviderCoverage = settings.providerScope.mode === "selected"
    && !settings.providerScope.providerIds.some(id =>
      settings.providerOptions.some(provider =>
        provider.id === id
        && provider.configured
        && !provider.disabled));
  return (
    <div className="guardrails-panel-stack">
      <section className="card">
        <div className="card-head"><strong>{t("guardrails.settingsTitle")}</strong></div>
        <p className="card-sub">{t("guardrails.settingsHint")}</p>
        <div className="guardrails-settings">
          <div className="guardrails-switch-row">
            <div><strong>{t("guardrails.enabled")}</strong><p>{t("guardrails.enabledHint")}</p></div>
            <Switch
              on={settings.enabled}
              disabled={pending}
              label={t("guardrails.enabled")}
              onClick={() => onSettings(
                { enabled: !settings.enabled },
                settings.enabled ? "disable" : undefined,
              )}
            />
          </div>
          <label className="guardrails-field">
            <span className="field-label">{t("guardrails.mode")}</span>
            <Select
              value={settings.mode}
              disabled={pending}
              label={t("guardrails.mode")}
              options={[
                { value: "enforce", label: t("guardrails.modeEnforce") },
                { value: "detect", label: t("guardrails.modeDetect") },
              ]}
              onChange={value => onSettings(
                { mode: value as GuardrailsMode },
                value === "detect" ? "detect" : undefined,
              )}
            />
          </label>
          <label className="guardrails-field">
            <span className="field-label">{t("guardrails.failurePolicy")}</span>
            <Select
              value={settings.failurePolicy}
              disabled={pending}
              label={t("guardrails.failurePolicy")}
              options={[
                { value: "block", label: t("guardrails.failureBlock") },
                { value: "passthrough", label: t("guardrails.failurePassthrough") },
              ]}
              onChange={value => onSettings(
                { failurePolicy: value as GuardrailsFailurePolicy },
                value === "passthrough" ? "passthrough" : undefined,
              )}
            />
          </label>
          <div className="guardrails-switch-row">
            <div><strong>{t("guardrails.keywordPrefilter")}</strong><p>{t("guardrails.keywordPrefilterHint")}</p></div>
            <Switch
              on={settings.keywordPrefilterEnabled}
              disabled={pending}
              label={t("guardrails.keywordPrefilter")}
              onClick={() => onSettings({
                keywordPrefilterEnabled: !settings.keywordPrefilterEnabled,
              })}
            />
          </div>
          <fieldset className="guardrails-types">
            <legend>{t("guardrails.providerScope")}</legend>
            <p className="muted">
              {t(settings.providerScope.mode === "all"
                ? "guardrails.providerScopeAllHint"
                : "guardrails.providerScopeSelectedHint")}
            </p>
            {settings.providerOptions.map(provider => {
              const checked = selectedProviderIds.includes(provider.id);
              return (
                <label key={provider.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={pending}
                    onChange={() => {
                      if (checked) {
                        const next = selectedProviderIds.filter(id => id !== provider.id);
                        if (next.length === 0) {
                          setProviderErrorFor(providerFingerprint);
                          return;
                        }
                        setProviderErrorFor(null);
                        onSettings(
                          { providerScope: { mode: "selected", providerIds: next } },
                          "limitProvider",
                        );
                        return;
                      }
                      const next = [...new Set([...selectedProviderIds, provider.id])].sort();
                      setProviderErrorFor(null);
                      onSettings({
                        providerScope: providerIds.every(id => next.includes(id))
                          ? { mode: "all" }
                          : { mode: "selected", providerIds: next },
                      });
                    }}
                  />
                  <span>
                    {provider.kind === "native"
                      ? t("guardrails.providerAnthropicNative")
                      : provider.id}
                    {provider.disabled ? ` · ${t("guardrails.providerDisabled")}` : ""}
                    {!provider.configured ? ` · ${t("guardrails.providerNotConfigured")}` : ""}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {providerError && (
            <p className="guardrails-field-error" role="alert">
              {t("guardrails.lastProviderRequired")}
            </p>
          )}
          <fieldset className="guardrails-types">
            <legend>{t("guardrails.dataTypes")}</legend>
            {GUARDRAILS_DATA_TYPES.map(dataType => (
              <label key={dataType}>
                <input
                  type="checkbox"
                  checked={settings.enabledDataTypes.includes(dataType)}
                  disabled={pending}
                  onChange={() => {
                    const disabling = settings.enabledDataTypes.includes(dataType);
                    const next = disabling
                      ? settings.enabledDataTypes.filter(value => value !== dataType)
                      : [...settings.enabledDataTypes, dataType].sort();
                    if (next.length === 0) {
                      setCoverageErrorFor(enabledDataTypesFingerprint);
                      return;
                    }
                    setCoverageErrorFor(null);
                    onSettings(
                      { enabledDataTypes: next },
                      disabling ? "disableCategory" : undefined,
                    );
                  }}
                />
                {t(GUARDRAILS_DATA_TYPE_KEYS[dataType])}
              </label>
            ))}
          </fieldset>
          {coverageError && (
            <p className="guardrails-field-error" role="alert">
              {t("guardrails.lastDataTypeRequired")}
            </p>
          )}
        </div>
      </section>
      {reducedCoverage && <Notice tone="warn">{t("guardrails.reducedCoverageWarning")}</Notice>}
      {settings.providerScope.mode === "selected" && (
        <Notice tone="warn">{t("guardrails.providerScopeWarning")}</Notice>
      )}
      {noProviderCoverage && (
        <Notice tone="warn">{t("guardrails.noProviderCoverageWarning")}</Notice>
      )}
      {settings.mode === "detect" && <Notice tone="warn">{t("guardrails.detectWarning")}</Notice>}
      {settings.failurePolicy === "passthrough" && <Notice tone="warn">{t("guardrails.passthroughWarning")}</Notice>}
      <p className="page-sub">
        <a href="https://opencodex.me/guides/guardrails/" target="_blank" rel="noreferrer">
          {t("guardrails.documentation")}
        </a>
      </p>
    </div>
  );
}
