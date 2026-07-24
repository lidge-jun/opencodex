import { useEffect, useMemo, useRef, useState } from "react";
import { IconX, IconLock, IconKey, IconExternal } from "../icons";
import { useT } from "../i18n";
import { providerIconSrc } from "../provider-icons";
import {
  buildProviderPostBody,
  codexPresetDescriptionKey,
  isReservedCodexForwardPreset,
  type ProviderPayload,
  type ProviderPayloadForm,
} from "../provider-payload";
import { oauthTosRisk } from "../oauth-tos-risk";
import OAuthTosWarningModal from "./OAuthTosWarningModal";
import ProviderCatalog from "./provider-catalog/ProviderCatalog";
import type { AccountLoginRow, AccountLoginStatus } from "./provider-catalog/ProviderCatalog";
import { isPresetActionable, type CatalogPreset } from "./provider-catalog/provider-presets";
import { baseUrlForChoice, matchChoiceId, resolvedBaseUrlForChoice } from "../base-url-choice";

export type ProviderConfig = ProviderPayload;

/** Local alias — the DTO type is owned by provider-catalog/provider-presets.ts. */
type Preset = CatalogPreset;

type FormState = ProviderPayloadForm;

export default function AddProviderModal({
  apiBase, existingNames, onClose, onAdded, initialTier, initialCustom = false,
  accountRows, accountStatus, accountBusy, onAccountLogin, onAccountCancelLogin, onAccountLogout, onOpen,
}: {
  apiBase: string;
  existingNames: string[];
  onClose: () => void;
  onAdded: (name: string) => void;
  /** Opening catalog tab (workspace empty-state tiles deep-link here). */
  initialTier?: "accounts" | "free" | "paid";
  /** Skip the catalog and open the custom-provider form immediately. */
  initialCustom?: boolean;
  accountRows?: AccountLoginRow[];
  accountStatus?: Record<string, AccountLoginStatus>;
  accountBusy?: string | null;
  onAccountLogin?: (provider: string) => void;
  onAccountCancelLogin?: (provider: string) => void;
  onAccountLogout?: (provider: string) => void;
  onOpen?: () => void;
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
      ? { name: "", adapter: "openai-chat", baseUrl: "", authMode: "key", apiKey: "", defaultModel: "", allowPrivateNetwork: false }
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
  const [oauthTosPending, setOauthTosPending] = useState<string | null>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [discoverySource, setDiscoverySource] = useState<"live" | "static" | "">("");
  const [discoveredModels, setDiscoveredModels] = useState<Array<{ id: string; contextWindow?: number }>>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const discoveryRequestRef = useRef(0);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const loadedPresetsRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Refresh OAuth status once when the modal opens (not when fetchOauth identity changes).
  useEffect(() => {
    aliveRef.current = true;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    onOpen?.();
    const dialog = dialogRef.current;
    if (dialog) {
      const focusable = dialog.querySelector<HTMLElement>(
        "input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      if (focusable) focusable.focus();
    }
    return () => {
      aliveRef.current = false;
      discoveryRequestRef.current += 1;
      discoveryAbortRef.current?.abort();
      discoveryAbortRef.current = null;
      previousFocusRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only open hook
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Child ToS warning owns keyboard navigation while it is open.
      if (e.key === "Escape" && !oauthTosPending) {
        onClose();
        return;
      }
      if (oauthTosPending) return;
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "a[href], input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      )).filter(node => node.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (e.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, oauthTosPending]);
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

  const invalidateDiscoveryRequest = () => {
    discoveryRequestRef.current += 1;
    discoveryAbortRef.current?.abort();
    discoveryAbortRef.current = null;
    setDiscoveryBusy(false);
  };

  const choosePreset = (p: Preset) => {
    invalidateDiscoveryRequest();
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
      defaultModel: p.defaultModel ?? p.models?.[0] ?? "",
      allowPrivateNetwork: false,
    });
    setError("");
    setOauthMsg("");
    setOauthMsgTone("ok");
    setManualCode("");
    setManualCodeMsg("");
    setManualCodeOk(true);
    setDiscoveryError("");
    setDiscoverySource(p.models?.length ? "static" : "");
    const staticModels = (p.models ?? []).map(id => ({ id }));
    setDiscoveredModels(staticModels);
    setSelectedModels(staticModels.map(model => model.id));
  };

  const back = () => {
    invalidateDiscoveryRequest();
    setPreset(null);
    setForm(null);
    setEndpointChoice("custom");
    setError("");
    setOauthMsg("");
    setOauthMsgTone("ok");
    setManualCode("");
    setManualCodeMsg("");
    setManualCodeOk(true);
    setDiscoveryError("");
    setDiscoverySource("");
    setDiscoveredModels([]);
    setSelectedModels([]);
  };

  const providerPostBody = () => {
    if (!form || !preset) return null;
    const resolvedBaseUrl = preset.baseUrlChoices?.length
      ? resolvedBaseUrlForChoice(preset.baseUrlChoices, endpointChoice, form.baseUrl)
      : form.baseUrl.trim();
    return buildProviderPostBody(preset, { ...form, baseUrl: resolvedBaseUrl });
  };

  const discoverModels = async () => {
    const postBody = providerPostBody();
    if (!postBody || !preset || preset.supportLevel === "reference") return;
    const requestId = discoveryRequestRef.current + 1;
    discoveryRequestRef.current = requestId;
    discoveryAbortRef.current?.abort();
    const controller = new AbortController();
    discoveryAbortRef.current = controller;
    setDiscoveryBusy(true);
    setDiscoveryError("");
    try {
      const res = await fetch(`${apiBase}/api/provider-presets/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId: preset.id, provider: postBody.provider }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({})) as {
        ok?: boolean;
        error?: string;
        source?: "live" | "static";
        models?: Array<string | { id: string; contextWindow?: number }>;
      };
      if (requestId !== discoveryRequestRef.current || controller.signal.aborted) return;
      if (!res.ok) throw new Error(data.error || t("modal.failedStatus", { status: res.status }));
      const models = (data.models ?? []).map(model => typeof model === "string" ? { id: model } : model).filter(model => model.id);
      if (data.ok === false && models.length === 0) throw new Error(data.error || t("modal.discoveryFailed"));
      setDiscoveredModels(models);
      setSelectedModels(models.map(model => model.id));
      setDiscoverySource(data.source ?? (preset.discovery === "static" ? "static" : "live"));
      if (data.error) setDiscoveryError(data.error);
      if (models[0]) setForm(current => current && !current.defaultModel ? { ...current, defaultModel: models[0]!.id } : current);
    } catch (cause) {
      if (requestId !== discoveryRequestRef.current || controller.signal.aborted) return;
      setDiscoveryError(cause instanceof Error ? cause.message : t("modal.networkError"));
    } finally {
      if (requestId === discoveryRequestRef.current) {
        discoveryAbortRef.current = null;
        setDiscoveryBusy(false);
      }
    }
  };

  const submit = async () => {
    if (!form) return;
    const reserved = preset ? isReservedCodexForwardPreset(preset) : false;
    const resolvedBaseUrl = preset?.baseUrlChoices?.length
      ? resolvedBaseUrlForChoice(preset.baseUrlChoices, endpointChoice, form.baseUrl)
      : form.baseUrl.trim();
    if (!reserved && !form.name.trim()) { setError(t("modal.nameRequired")); return; }
   if (!reserved && !resolvedBaseUrl) { setError(t("modal.baseUrlRequired")); return; }
    if (!reserved && /\{[^}]*\}/.test(resolvedBaseUrl)) { setError(t("modal.baseUrlPlaceholderError")); return; }
    const submitForm = { ...form, baseUrl: resolvedBaseUrl };
    let postBody: { name: string; provider: ProviderPayload };
    try {
      postBody = buildProviderPostBody(preset ?? { id: "custom" }, submitForm);
    } catch {
      setError(t("modal.invalidPreset"));
      return;
    }

    setSaving(true);
    setError("");
    try {
      const selectedSubset = selectedModels.length > 0 && selectedModels.length < discoveredModels.length
        ? selectedModels
        : undefined;
      const res = await fetch(`${apiBase}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...postBody,
          provider: selectedSubset ? { ...postBody.provider, selectedModels: selectedSubset } : postBody.provider,
        }),
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

  const requestLoginOAuth = (providerId: string) => {
    if (oauthBusy) return;
    if (oauthTosRisk(providerId)) {
      setOauthTosPending(providerId);
      return;
    }
    void loginOAuth(providerId);
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
  const isReference = preset ? !isPresetActionable(preset) : false;
  const selectedIcon = preset ? providerIconSrc(preset.id, { adapter: preset.adapter, baseUrl: preset.baseUrl }) : undefined;
  const setupUrl = preset?.dashboardUrl ?? preset?.documentationUrl;

  return (
    <>
    <div role="dialog" aria-modal="true" aria-label={t("modal.add")} className="modal-overlay provider-loader-overlay" onClick={onClose}>
      <div ref={dialogRef} className="modal-card provider-loader-card" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t("modal.add")}</h3>
          <button className="btn btn-ghost btn-icon" aria-label={t("common.close")} onClick={onClose}><IconX /></button>
        </div>

        <ProviderCatalog
          presets={presets}
          usageRank={usageRank}
          presetsLoading={presetsLoading}
          initialTier={initialTier}
          onSelectPreset={p => choosePreset(p)}
          onSelectCustom={() => choosePreset(fallbackPresets[0]!)}
          accountRows={accountRows}
          accountStatus={accountStatus}
          busyProvider={accountBusy}
          onLogin={onAccountLogin}
          onCancelLogin={onAccountCancelLogin}
          onLogout={onAccountLogout}
          onClearSelection={back}
          selectedPreset={preset}
          standalone={initialCustom && preset?.id === "custom"}
          detail={preset && form ? (
          preset.auth === "oauth" && form.authMode === "oauth" ? (
            // OAuth login pane
            <div className="provider-detail-form">
              <button className="link-btn provider-detail-mobile-back" type="button" onClick={back}>{t("modal.backToDirectory")}</button>
              <ProviderDetailHeader preset={preset} icon={selectedIcon} />
              <div className="muted text-control">{preset.note ?? t("modal.oauthDefaultNote")}</div>
              {oauthSupported.includes(preset.oauthProvider ?? "") ? (
                <button className="btn btn-primary" onClick={() => requestLoginOAuth(preset.oauthProvider!)} disabled={oauthBusy}
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
            <div className="provider-detail-form">
              <button className="link-btn provider-detail-mobile-back" type="button" onClick={back}>{t("modal.backToDirectory")}</button>
              <ProviderDetailHeader preset={preset} icon={selectedIcon} />
              {!isReservedForward && !isCustom && !isLocal && (
                <div className="provider-detail-guide">
                  <strong>{t("modal.setupGuide")}</strong>
                  <ol>
                    <li>
                      {setupUrl ? <>
                        {t("modal.setupStep1Prefix")}{" "}
                        <a href={setupUrl} target="_blank" rel="noreferrer">{t("modal.setupDashboardLink", { label: preset.label })}</a>
                        {!preset.keyOptional && !isReference ? <> {t("modal.setupStep1Suffix")}</> : null}
                      </> : t("modal.setupReviewProvider", { label: preset.label })}
                    </li>
                    {isReference ? <li>{t("modal.setupReferenceStep")}</li> : preset.keyOptional ? <>
                      <li>{t("modal.setupKeylessStep")}</li>
                      <li>{t("modal.setupDiscoverStep")}</li>
                    </> : <>
                      <li>{t("modal.setupStep2")}</li>
                      <li>{t("modal.setupStep3")}</li>
                    </>}
                  </ol>
                 {preset.note && <div className="text-label" style={{ color: "var(--muted)", marginTop: 8 }}>{preset.note}</div>}
                  {/\{[^}]*\}/.test(form.baseUrl) && (<div className="text-label" style={{ color: "var(--amber)", marginTop: 6 }}>{t("modal.baseUrlPlaceholderHint")}</div>)}
                </div>
              )}
              {isReference && <div className="provider-detail-reference" role="status">{t("modal.referenceExplanation")}</div>}
              {!isReference && <>
              <Field label={t("modal.providerName")}>
                <input className="input" value={form.name} readOnly={isReservedForward} onChange={e => setForm({ ...form, name: e.target.value })} placeholder={t("modal.namePlaceholder")} />
              </Field>
              {dup && <div className="text-label" style={{ color: "var(--amber)" }}>{t("modal.duplicateWarn", { name: form.name.trim() })}</div>}
              {!isReservedForward && <>
                <Field label={t("modal.adapter")}>
                  <select className="input" value={form.adapter} onChange={e => {
                    invalidateDiscoveryRequest();
                    setForm({ ...form, adapter: e.target.value });
                  }}>
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
                          invalidateDiscoveryRequest();
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
                              : c.id === "china-mainland" ? t("modal.endpoint.chinaMainland")
                              : c.id === "international" ? t("modal.endpoint.international")
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
                          onChange={e => {
                            invalidateDiscoveryRequest();
                            setForm({ ...form, baseUrl: e.target.value });
                          }}
                          placeholder={t("modal.baseUrlPlaceholder")}
                        />
                      </Field>
                    )}
                  </>
                ) : (
                  <Field label={t("modal.baseUrl")}>
                    <input className="input" value={form.baseUrl} onChange={e => {
                      invalidateDiscoveryRequest();
                      setForm({ ...form, baseUrl: e.target.value });
                    }} placeholder={t("modal.baseUrlPlaceholder")} />
                  </Field>
                )}
                {!isReservedForward && (
                  <label className="modal-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={form?.allowPrivateNetwork ?? false} onChange={e => {
                      invalidateDiscoveryRequest();
                      setForm(f => f ? { ...f, allowPrivateNetwork: e.target.checked } : f);
                    }} />
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
                  <Field label={t("modal.apiKey")}>
                    <input className="input" type="password" value={form.apiKey} onChange={e => {
                      invalidateDiscoveryRequest();
                      setForm({ ...form, apiKey: e.target.value });
                    }} placeholder={t("modal.apiKeyPlaceholder")} />
                  </Field>
                </>
              )}
              {!isReservedForward && <Field label={t("modal.defaultModel")}>
                <input className="input" value={form.defaultModel} onChange={e => setForm({ ...form, defaultModel: e.target.value })} placeholder={t("modal.defaultModelPlaceholder")} />
              </Field>}
              {!isReservedForward && !isCustom && (
                <div className="provider-model-discovery">
                  <div className="provider-model-discovery-head">
                    <div>
                      <strong>{t("modal.modelDiscovery")}</strong>
                      <div className="provider-model-source">
                        {discoverySource ? t(discoverySource === "live" ? "modal.modelsLive" : "modal.modelsStatic") : t("modal.modelDiscoveryHint")}
                      </div>
                    </div>
                    <button className="btn btn-ghost" type="button" onClick={() => void discoverModels()} disabled={discoveryBusy || isReference || preset.discovery === "unsupported"}>
                      {discoveryBusy ? t("modal.discovering") : t("modal.discoverModels")}
                    </button>
                  </div>
                  {discoveryError && <div className="text-label" role="alert" style={{ color: discoverySource === "static" && discoveredModels.length ? "var(--amber)" : "var(--red)" }}>{discoveryError}</div>}
                  {discoveredModels.length > 0 && (
                    <div className="provider-model-list" aria-label={t("modal.discoveredModels")}>
                      {discoveredModels.map(model => {
                        const checked = selectedModels.includes(model.id);
                        return (
                          <label key={model.id} className="provider-model-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={checked && selectedModels.length === 1}
                              onChange={() => {
                                const nextSelected = checked
                                  ? selectedModels.filter(id => id !== model.id)
                                  : [...selectedModels, model.id];
                                setSelectedModels(nextSelected);
                                setForm(current => current ? {
                                  ...current,
                                  defaultModel: checked && current.defaultModel === model.id
                                    ? (nextSelected[0] ?? "")
                                    : !checked ? model.id : current.defaultModel,
                                } : current);
                              }}
                            />
                            <code>{model.id}</code>
                            {model.contextWindow && <span className="muted" style={{ marginLeft: "auto" }}>{model.contextWindow.toLocaleString()}</span>}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              </>}
              {error && <div className="text-control" role="alert" style={{ color: "var(--red)" }}>{error}</div>}
              <div className="provider-detail-actions">
                {!isReference && <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? t("modal.adding") : t("modal.add")}</button>}
                {preset.auth === "oauth" && <button className="link-btn" onClick={() => {
                  invalidateDiscoveryRequest();
                  setForm({ ...form, authMode: "oauth" });
                  setError("");
                }}>{t("modal.useOauthLogin")}</button>}
                <div className="provider-detail-spacer" />
                <button className="btn btn-ghost" onClick={back}>{t("modal.back")}</button>
              </div>
            </div>
          )
          ) : undefined}
        />
      </div>
    </div>
    {oauthTosPending && (
      <OAuthTosWarningModal
        key={oauthTosPending}
        providerId={oauthTosPending}
        providerLabel={preset?.label ?? oauthTosPending}
        onCancel={() => setOauthTosPending(null)}
        onContinue={() => {
          const id = oauthTosPending;
          if (!id) return;
          setOauthTosPending(null);
          void loginOAuth(id);
        }}
      />
    )}
    </>
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

function ProviderDetailHeader({ preset, icon }: { preset: Preset; icon?: string }) {
  const t = useT();
  const docs = preset.documentationUrl ?? preset.dashboardUrl;
  return (
    <div className="provider-detail-header">
      <span className="provider-catalog-icon">{icon ? <img src={icon} alt="" aria-hidden="true" /> : preset.label.slice(0, 1)}</span>
      <div className="provider-detail-title">
        <h4>{preset.label}</h4>
        <code className="muted">{preset.id}</code>
        <div className="provider-detail-meta">
          {preset.accessGroups?.map(group => (
            <span key={group} className={`badge ${group === "signup-credit" ? "badge-amber" : "badge-green"}`}>
              {t(`modal.group.${group}`)}
            </span>
          ))}
          {preset.supportLevel && <span className={`badge ${preset.supportLevel === "reference" ? "badge-amber" : preset.supportLevel === "experimental" ? "badge-muted" : "badge-accent"}`}>
            {t(preset.supportLevel === "reference" ? "modal.badge.reference" : preset.supportLevel === "experimental" ? "modal.badge.experimental" : "modal.badge.supported")}
          </span>}
          {preset.verification && <span className="badge badge-muted">{t(`modal.verification.${preset.verification}`)}</span>}
        </div>
      </div>
      {docs && <a className="provider-detail-docs" href={docs} target="_blank" rel="noreferrer">{t("modal.providerDocs")}<IconExternal /></a>}
    </div>
  );
}
