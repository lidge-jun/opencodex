import { IconExternal, IconKey } from "../icons";
import { useT } from "../i18n/shared";
import type { CatalogPreset } from "./provider-catalog/provider-presets";
import type { ProviderPayloadForm } from "../provider-payload";
import { AddProviderField } from "./add-provider-modal-field";
import { baseUrlForChoice } from "../base-url-choice";

export function AddProviderFormPane({
  preset,
  form,
  endpointChoice,
  error,
  saving,
  dup,
  isCustom,
  isLocal,
  isReservedForward,
  presetDescription,
  onFormChange,
  onEndpointChoiceChange,
  onSubmit,
  onUseOauthLogin,
  onBack,
}: {
  preset: CatalogPreset;
  form: ProviderPayloadForm;
  endpointChoice: string;
  error: string;
  saving: boolean;
  dup: boolean;
  isCustom: boolean;
  isLocal: boolean;
  isReservedForward: boolean;
  presetDescription: (candidate: CatalogPreset) => string | undefined;
  onFormChange: (next: ProviderPayloadForm) => void;
  onEndpointChoiceChange: (choiceId: string) => void;
  onSubmit: () => void;
  onUseOauthLogin: () => void;
  onBack: () => void;
}) {
  const t = useT();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {!isReservedForward && !isCustom && !isLocal && !preset.keyOptional && preset.note && (
        <details className="setup-guide">
          <summary>{t("modal.setupGuide")}</summary>
          <ol className="text-label leading-relaxed" style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--muted)" }}>
            <li>
              {t("modal.setupStep1Prefix")}{" "}
              <a href={preset.dashboardUrl} target="_blank" rel="noreferrer">
                {t("modal.setupDashboardLink", { label: preset.label })}
              </a>{" "}
              {t("modal.setupStep1Suffix")}
            </li>
            <li>{t("modal.setupStep2")}</li>
            <li>{t("modal.setupStep3")}</li>
          </ol>
          {preset.note && <div className="text-label" style={{ color: "var(--muted)", marginTop: 6, fontStyle: "italic" }}>{preset.note}</div>}
          {/\{[^}]*\}/.test(form.baseUrl) && (<div className="text-label" style={{ color: "var(--amber)", marginTop: 6 }}>{t("modal.baseUrlPlaceholderHint")}</div>)}
        </details>
      )}
      <AddProviderField label={t("modal.providerName")}>
        <input className="input" value={form.name} readOnly={isReservedForward} onChange={e => onFormChange({ ...form, name: e.target.value })} placeholder={t("modal.namePlaceholder")} />
      </AddProviderField>
      {dup && <div className="text-label" style={{ color: "var(--amber)" }}>{t("modal.duplicateWarn", { name: form.name.trim() })}</div>}
      {!isReservedForward && <>
        <AddProviderField label={t("modal.adapter")}>
          <select className="input" value={form.adapter} onChange={e => onFormChange({ ...form, adapter: e.target.value })}>
            {["openai-responses", "openai-chat", "anthropic", "google", "azure-openai", "cursor"].map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </AddProviderField>
        {preset.baseUrlChoices && preset.baseUrlChoices.length > 0 ? (
          <>
            <AddProviderField label={t("modal.endpoint")}>
              <select
                className="input"
                value={endpointChoice}
                onChange={e => {
                  const id = e.target.value;
                  onEndpointChoiceChange(id);
                  onFormChange({
                    ...form,
                    baseUrl: baseUrlForChoice(preset.baseUrlChoices, id, form.baseUrl),
                  });
                }}
              >
                {preset.baseUrlChoices.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.id === "token-plan" ? t("modal.endpoint.tokenPlan")
                      : c.id === "payg" ? t("modal.endpoint.payAsYouGo")
                      : c.id === "custom" ? t("modal.endpoint.custom")
                      : c.label}
                  </option>
                ))}
              </select>
            </AddProviderField>
            {endpointChoice === "custom" && (
              <AddProviderField label={t("modal.baseUrl")}>
                <input
                  className="input"
                  value={form.baseUrl}
                  onChange={e => onFormChange({ ...form, baseUrl: e.target.value })}
                  placeholder={t("modal.baseUrlPlaceholder")}
                />
              </AddProviderField>
            )}
          </>
        ) : (
          <AddProviderField label={t("modal.baseUrl")}>
            <input className="input" value={form.baseUrl} onChange={e => onFormChange({ ...form, baseUrl: e.target.value })} placeholder={t("modal.baseUrlPlaceholder")} />
          </AddProviderField>
        )}
        {!isReservedForward && (
          <label className="modal-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={form?.allowPrivateNetwork ?? false} onChange={e => onFormChange({ ...form, allowPrivateNetwork: e.target.checked })} />
            <span className="muted text-control">{t("modal.allowPrivateNetwork")}</span>
          </label>
        )}
        {!isReservedForward && (form?.allowPrivateNetwork ?? false) && (
          <p className="muted text-hint">{t("modal.allowPrivateNetworkHint")}</p>
        )}
      </>}
      {form.authMode === "forward" ? (
        <div className="text-label" style={{ color: "var(--green)", background: "var(--green-soft)", border: "1px solid var(--green)", borderRadius: "var(--radius-sm)", padding: "8px 10px" }}>
          {presetDescription(preset)}
        </div>
      ) : form.authMode === "local" ? (
        <div className="text-label leading-relaxed" style={{ color: "var(--amber)", background: "var(--amber-soft)", border: "1px solid var(--amber)", borderRadius: "var(--radius-sm)", padding: "8px 10px" }}>
          {t("modal.localHint")}
        </div>
      ) : preset.keyOptional ? (
        <div className="text-label leading-relaxed" style={{ color: "var(--green)", background: "var(--green-soft)", border: "1px solid var(--green)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}>
          <strong>{t("modal.freeTierTitle")}</strong> — {preset.note ?? t("modal.freeTierDefault")}
        </div>
      ) : (
        <>
          {preset.dashboardUrl && (
            <a className="text-label" href={preset.dashboardUrl} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <IconKey style={{ width: 14, height: 14 }} />{t("modal.getApiKey", { label: preset.label })}<IconExternal style={{ width: 13, height: 13 }} />
            </a>
          )}
          <AddProviderField label={t("modal.apiKey")}>
            <input className="input" type="password" value={form.apiKey} onChange={e => onFormChange({ ...form, apiKey: e.target.value })} placeholder={t("modal.apiKeyPlaceholder")} />
          </AddProviderField>
          {form.adapter === "anthropic" && form.authMode === "key" && (
            <AddProviderField label={t("modal.apiKeyTransport")}>
              <select
                className="input"
                value={form.apiKeyTransport ?? "x-api-key"}
                onChange={e => onFormChange({ ...form, apiKeyTransport: e.target.value === "bearer" ? "bearer" : undefined })}
              >
                <option value="x-api-key">{t("modal.apiKeyTransportNative")}</option>
                <option value="bearer">{t("modal.apiKeyTransportBearer")}</option>
              </select>
            </AddProviderField>
          )}
        </>
      )}
      {!isReservedForward && <AddProviderField label={t("modal.defaultModel")}>
        <input className="input" value={form.defaultModel} onChange={e => onFormChange({ ...form, defaultModel: e.target.value })} placeholder={t("modal.defaultModelPlaceholder")} />
      </AddProviderField>}
      {error && <div className="text-control" role="alert" style={{ color: "var(--red)" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
        <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={saving}>{saving ? t("modal.adding") : t("modal.add")}</button>
        {preset.auth === "oauth" && <button type="button" className="link-btn" onClick={onUseOauthLogin}>{t("modal.useOauthLogin")}</button>}
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost" onClick={onBack}>{t("modal.back")}</button>
      </div>
    </div>
  );
}
