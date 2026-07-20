import { useEffect, useMemo, useRef, useState } from "react";
import { IconX, IconLock, IconKey, IconExternal } from "../icons";
import { useT } from "../i18n";
import {
  buildProviderPostBody,
  codexPresetDescriptionKey,
  isReservedCodexForwardPreset,
  type ProviderPayload,
  type ProviderPayloadForm,
} from "../provider-payload";
import ProviderCatalog from "./provider-catalog/ProviderCatalog";
import type { CatalogPreset } from "./provider-catalog/provider-presets";
import { baseUrlForChoice, matchChoiceId } from "../base-url-choice";

export type ProviderConfig = ProviderPayload;

/** Local alias — the DTO type is owned by provider-catalog/provider-presets.ts. */
type Preset = CatalogPreset;

type FormState = ProviderPayloadForm;

export default function AddProviderModal({
  apiBase, existingNames, onClose, onAdded, initialTier, initialCustom = false,
}: {
  apiBase: string;
  existingNames: string[];
  onClose: () => void;
  onAdded: (name: string) => void;
  /** Opening catalog tab (workspace empty-state tiles deep-link here). */
  initialTier?: "accounts" | "free" | "paid";
  /** Skip the catalog and open the custom-provider form immediately. */
  initialCustom?: boolean;
}) {
  const t = useT();
  const fallbackPresets = useMemo<Preset[]>(() => [
    { id: "custom", label: t("modal.customProvider"), adapter: "openai-chat", baseUrl: "", auth: "key" },
  ], [t]);
  const [preset, setPreset] = useState<Preset | null>(
    initialCustom ? { id: "custom", label: t("modal.customProvider"), adapter: "openai-chat", baseUrl: "", auth: "key" } : null,
  );
  const [form, setForm] = useState<FormState | null>(
    initialCustom
      ? { name: "", adapter: "openai-chat", baseUrl: "", authMode: "key", apiKey: "", defaultModel: "" }
      : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [oauthSupported, setOauthSupported] = useState<string[]>([]);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthMsg, setOauthMsg] = useState("");
  const [oauthMsgTone, setOauthMsgTone] = useState<"ok" | "warn">("ok");
  const [manualCode, setManualCode] = useState("");
  const [manualCodeBusy, setManualCodeBusy] = useState(false);
  const [manualCodeMsg, setManualCodeMsg] = useState("");
  const [manualCodeOk, setManualCodeOk] = useState(true);
  const [presets, setPresets] = useState<Preset[]>(fallbackPresets);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [usageRank, setUsageRank] = useState<Record<string, number>>({});
  const [endpointChoice, setEndpointChoice] = useState("custom");
  const aliveRef = useRef(true);
  const loadedPresetsRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Cleanup + focus-trap: save previous focus on mount, restore on unmount.
  useEffect(() => {
    aliveRef.current = true;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog) {
      const focusable = dialog.querySelector<HTMLElement>(
        "input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      if (focusable) focusable.focus();
    }
    return () => {
      aliveRef.current = false;
      previousFocusRef.current?.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    fetch(`${apiBase}/api/oauth/providers`).then(r => r.json()).then(d => setOauthSupported(d.providers ?? [])).catch(() => {});
  }, [apiBase]);
  useEffect(() => {
    fetch(`${apiBase}/api/provider-presets`).then(r => r.json()).then((d: { providers?: Preset[] }) => {
      if (Array.isArray(d.providers) && d.providers.length > 0) {
        loadedPresetsRef.current = true;
        setPresets(d.providers);
      }
    }).catch(() => {}).finally(() => setPresetsLoading(false));
  }, [apiBase]);
  // Usage rank drives the catalog's default row order (most-used first).
  useEffect(() => {
    fetch(`${apiBase}/api/usage?range=30d`).then(r => r.json()).then((d: {
      providers?: Array<{ provider: string; requests: number }>;
    }) => {
      const rank: Record<string, number> = {};
      for (const row of d.providers ?? []) rank[row.provider] = row.requests;
      setUsageRank(rank);
    }).catch(() => {});
  }, [apiBase]);
  // Keep the custom fallback label in sync when language changes and API presets never loaded.
  useEffect(() => {
    if (!loadedPresetsRef.current) setPresets(fallbackPresets);
  }, [fallbackPresets]);

  const presetDescription = (candidate: Preset): string | undefined => {
    const key = codexPresetDescriptionKey(candidate);
    return key ? t(key) : candidate.note;
  };

  const choosePreset = (p: Preset) => {
    setPreset(p);
    const choiceId = matchChoiceId(p.baseUrlChoices, p.baseUrl);
    setEndpointChoice(choiceId);
    setForm({
      name: p.id === "custom" ? "" : p.id,
      adapter: p.adapter,
      baseUrl: p.baseUrlChoices?.length
        ? baseUrlForChoice(p.baseUrlChoices, choiceId, p.baseUrl)
        : p.baseUrl,
      authMode: p.auth,
      apiKey: "",
      defaultModel: p.defaultModel ?? "",
    });
    setError("");
    setOauthMsg("");
    setOauthMsgTone("ok");
    setManualCode("");
    setManualCodeMsg("");
    setManualCodeOk(true);
  };

  const back = () => {
    setPreset(null);
    setForm(null);
    setEndpointChoice("custom");
    setError("");
    setOauthMsg("");
    setOauthMsgTone("ok");
    setManualCode("");
    setManualCodeMsg("");
    setManualCodeOk(true);
  };

  const submit = async () => {
    if (!form) return;
    const reserved = preset ? isReservedCodexForwardPreset(preset) : false;
    if (!reserved && !form.name.trim()) { setError(t("modal.nameRequired")); return; }
    if (!reserved && !form.baseUrl.trim()) { setError(t("modal.baseUrlRequired")); return; }
    let postBody: { name: string; provider: ProviderPayload };
    try {
      postBody = buildProviderPostBody(preset ?? { id: "custom" }, form);
    } catch {
      setError(t("modal.invalidPreset"));
      return;
    }

    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${apiBase}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || t("modal.failedStatus", { status: res.status }));
        return;
      }
      onAdded(postBody.name);
    } catch {
      setError(t("modal.networkError"));
    } finally {
      setSaving(false);
    }
  };

  // Real OAuth login: open the provider's auth page in a new tab, poll until the proxy stores the token.
  const loginOAuth = async (providerId: string) => {
    setOauthBusy(true);
    setOauthMsg("");
    setOauthMsgTone("ok");
    setManualCode("");
    setManualCodeMsg("");
    setManualCodeOk(true);
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await res.json();
      if (!aliveRef.current) return;
      if (!res.ok) {
        setOauthMsgTone("warn");
        setOauthMsg(data.error === "unknown oauth provider"
          ? t("modal.oauthComingSoonShort")
          : (data.error || t("modal.loginFailStart")));
        return;
      }
      // A non-empty url = browser/device flow (the server also opens it). An EMPTY url with a 200 =
      // a local-token import (e.g. Anthropic's Claude Code keychain, Grok CLI) that needs no browser
      // — just poll status until the credential lands. Don't treat empty url as a failure.
      if (data.url) { setOauthMsg(t("modal.waitingLogin")); }
      else { setOauthMsg(data.instructions || t("modal.loggingIn")); }
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (!aliveRef.current) return; // modal closed → stop polling, don't fire onAdded
        const s = await fetch(`${apiBase}/api/oauth/status?provider=${providerId}`).then(r => r.json()).catch(() => null);
        if (!aliveRef.current) return;
        if (s?.loggedIn) { onAdded(providerId); return; }
        if (s?.error) {
          setOauthMsgTone("warn");
          setOauthMsg(t("modal.loginError", { error: s.error }));
          return;
        }
      }
      setOauthMsgTone("warn");
      setOauthMsg(t("modal.loginTimeout"));
    } catch {
      if (aliveRef.current) {
        setOauthMsgTone("warn");
        setOauthMsg(t("modal.networkError"));
      }
    } finally {
      if (aliveRef.current) setOauthBusy(false);
    }
  };

  const submitManualCode = async (providerId: string) => {
    const input = manualCode.trim();
    if (!input || manualCodeBusy) return;
    setManualCodeBusy(true);
    setManualCodeMsg("");
    try {
      const res = await fetch(`${apiBase}/api/oauth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, input }),
      });
      const data = await res.json().catch(() => ({}));
      if (!aliveRef.current) return;
      if (!res.ok) {
        setManualCodeOk(false);
        setManualCodeMsg(t("prov.pasteFail", { error: data.error || res.statusText }));
        return;
      }
      setManualCode("");
      setManualCodeOk(true);
      setManualCodeMsg(t("prov.pasteOk"));
    } catch {
      if (aliveRef.current) {
        setManualCodeOk(false);
        setManualCodeMsg(t("modal.networkError"));
      }
    } finally {
      if (aliveRef.current) setManualCodeBusy(false);
    }
  };

  const dup = form ? existingNames.includes(form.name.trim()) && form.name.trim() !== "" : false;
  const isCustom = preset?.id === "custom";
  const isLocal = form?.authMode === "local";
  const isReservedForward = preset ? isReservedCodexForwardPreset(preset) : false;

  return (
    <div role="dialog" aria-modal="true" aria-label={t("modal.add")} className="modal-overlay" onClick={onClose}>
      <div ref={dialogRef} className="modal-card" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{preset ? t("modal.addNamed", { label: preset.label }) : t("modal.add")}</h3>
          <button className="btn btn-ghost btn-icon" aria-label={t("common.close")} onClick={onClose}><IconX /></button>
        </div>

        {!preset ? (
          <ProviderCatalog
            presets={presets}
            usageRank={usageRank}
            presetsLoading={presetsLoading}
            initialTier={initialTier}
            onSelectPreset={p => choosePreset(p)}
            onSelectCustom={() => choosePreset(fallbackPresets[0]!)}
          />
        ) : form && (
          preset.auth === "oauth" && form.authMode === "oauth" ? (
            // OAuth login pane
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="muted text-control">{preset.note ?? t("modal.oauthDefaultNote")}</div>
              {oauthSupported.includes(preset.oauthProvider ?? "") ? (
                <button className="btn btn-primary" onClick={() => loginOAuth(preset.oauthProvider!)} disabled={oauthBusy}
                  style={{ width: "100%", padding: "12px 16px" }}>
                  <IconLock />{oauthBusy ? t("modal.waitingBrowser") : t("modal.logInWith", { label: preset.label })}
                </button>
              ) : (
                <div className="text-control" style={{ color: "var(--amber)", background: "var(--amber-soft)", border: "1px solid var(--amber)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}>
                  {t("modal.oauthComingSoon", { label: preset.label })}
                </div>
              )}
              {oauthMsg && (
                <div className="text-label" style={{ color: oauthMsgTone === "warn" ? "var(--amber)" : "var(--accent-hover)" }}>
                  {oauthMsg}
                </div>
              )}
              {oauthBusy && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div className="muted text-label">
                    {t("prov.pasteRedirectHint")}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={manualCode}
                      onChange={e => setManualCode(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && preset.oauthProvider) {
                          e.preventDefault();
                          void submitManualCode(preset.oauthProvider);
                        }
                      }}
                      placeholder={t("prov.pasteRedirect")}
                      aria-label={t("prov.pasteRedirect")}
                      disabled={manualCodeBusy}
                      className="input text-label"
                      style={{ flex: 1 }}
                    />
                    <button
                      className="btn btn-ghost"
                      type="button"
                      disabled={manualCodeBusy || !manualCode.trim() || !preset.oauthProvider}
                      onClick={() => preset.oauthProvider && void submitManualCode(preset.oauthProvider)}
                    >
                      {manualCodeBusy ? t("prov.pasteSubmitting") : t("prov.pasteSubmit")}
                    </button>
                  </div>
                  {manualCodeMsg && (
                    <div className="text-label" style={{ color: manualCodeOk ? "var(--accent-hover)" : "var(--amber)" }}>
                      {manualCodeMsg}
                    </div>
                  )}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
                <button
                  className="link-btn"
                  onClick={() => {
                    setForm({ ...form, authMode: "key" });
                    setOauthMsg("");
                    setOauthMsgTone("ok");
                    setManualCode("");
                    setManualCodeMsg("");
                  }}
                >
                  {t("modal.useApiKeyInstead")}
                </button>
                <div style={{ flex: 1 }} />
                <button className="btn btn-ghost" onClick={back}>{t("modal.back")}</button>
              </div>
            </div>
          ) : (
            // API key / Codex-forward / free-tier form
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
                </details>
              )}
              <Field label={t("modal.providerName")}>
                <input className="input" value={form.name} readOnly={isReservedForward} onChange={e => setForm({ ...form, name: e.target.value })} placeholder={t("modal.namePlaceholder")} />
              </Field>
              {dup && <div className="text-label" style={{ color: "var(--amber)" }}>{t("modal.duplicateWarn", { name: form.name.trim() })}</div>}
              {!isReservedForward && <>
                <Field label={t("modal.adapter")}>
                  <select className="input" value={form.adapter} onChange={e => setForm({ ...form, adapter: e.target.value })}>
                    {["openai-responses", "openai-chat", "anthropic", "google", "azure-openai", "cursor"].map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                </Field>
                {preset.baseUrlChoices && preset.baseUrlChoices.length > 0 ? (
                  <>
                    <Field label={t("modal.endpoint")}>
                      <select
                        className="input"
                        value={endpointChoice}
                        onChange={e => {
                          const id = e.target.value;
                          setEndpointChoice(id);
                          setForm({
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
                    </Field>
                    {endpointChoice === "custom" && (
                      <Field label={t("modal.baseUrl")}>
                        <input
                          className="input"
                          value={form.baseUrl}
                          onChange={e => setForm({ ...form, baseUrl: e.target.value })}
                          placeholder={t("modal.baseUrlPlaceholder")}
                        />
                      </Field>
                    )}
                  </>
                ) : (
                  <Field label={t("modal.baseUrl")}>
                    <input className="input" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder={t("modal.baseUrlPlaceholder")} />
                  </Field>
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
                  <Field label={t("modal.apiKey")}>
                    <input className="input" type="password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder={t("modal.apiKeyPlaceholder")} />
                  </Field>
                </>
              )}
              {!isReservedForward && <Field label={t("modal.defaultModel")}>
                <input className="input" value={form.defaultModel} onChange={e => setForm({ ...form, defaultModel: e.target.value })} placeholder={t("modal.defaultModelPlaceholder")} />
              </Field>}
              {error && <div className="text-control" role="alert" style={{ color: "var(--red)" }}>{error}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
                <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? t("modal.adding") : t("modal.add")}</button>
                {preset.auth === "oauth" && <button className="link-btn" onClick={() => { setForm({ ...form, authMode: "oauth" }); setError(""); }}>{t("modal.useOauthLogin")}</button>}
                <div style={{ flex: 1 }} />
                <button className="btn btn-ghost" onClick={back}>{t("modal.back")}</button>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
