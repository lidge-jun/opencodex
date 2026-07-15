import { useEffect, useMemo, useRef, useState } from "react";
import { IconX, IconLock, IconKey, IconExternal } from "../icons";
import { useT } from "../i18n";
import { buildProviderPayload, type ProviderPayload } from "../provider-payload";

export type ProviderConfig = ProviderPayload;

interface Preset {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  /** "oauth": account login · "forward": ChatGPT passthrough · "key": API key · "local": local scaffold. */
  auth: "oauth" | "forward" | "key" | "local";
  /** OAuth registry id (for auth === "oauth"). */
  oauthProvider?: string;
  /** Where to create/copy the API key (for auth === "key" catalog providers). */
  dashboardUrl?: string;
  note?: string;
  /** API key is optional — provider works without one (free public tier). */
  keyOptional?: boolean;
}

interface FormState {
  name: string;
  adapter: string;
  baseUrl: string;
  authMode: "key" | "forward" | "oauth" | "local";
  apiKey: string;
  defaultModel: string;
}

export default function AddProviderModal({
  apiBase, existingNames, onClose, onAdded, initialCustom = false,
}: {
  apiBase: string;
  existingNames: string[];
  onClose: () => void;
  onAdded: (name: string) => void;
  /** Skip catalog picker and open the custom-provider form immediately. */
  initialCustom?: boolean;
}) {
  const t = useT();
  const fallbackPresets = useMemo<Preset[]>(() => [
    { id: "custom", label: t("modal.customProvider"), adapter: "openai-chat", baseUrl: "", auth: "key" },
  ], [t]);
  const [query, setQuery] = useState("");
  const [preset, setPreset] = useState<Preset | null>(initialCustom ? fallbackPresets[0]! : null);
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
  const searchRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);
  const loadedPresetsRef = useRef(false);

  useEffect(() => { if (!initialCustom) searchRef.current?.focus(); }, [initialCustom]);
  useEffect(() => () => { aliveRef.current = false; }, []); // stop the OAuth poll if the modal unmounts
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
    }).catch(() => {});
  }, [apiBase]);
  // Keep the custom fallback label in sync when language changes and API presets never loaded.
  useEffect(() => {
    if (!loadedPresetsRef.current) setPresets(fallbackPresets);
  }, [fallbackPresets]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return presets;
    // Match by provider name/id — not adapter, since most share "openai-chat" and would all match.
    return presets.filter(p => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [query, presets]);

  const choosePreset = (p: Preset) => {
    setPreset(p);
    setForm({
      name: p.id === "custom" ? "" : p.id,
      adapter: p.adapter,
      baseUrl: p.baseUrl,
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
    setError("");
    setOauthMsg("");
    setOauthMsgTone("ok");
    setManualCode("");
    setManualCodeMsg("");
    setManualCodeOk(true);
  };

  const submit = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) { setError(t("modal.nameRequired")); return; }
    if (!form.baseUrl.trim()) { setError(t("modal.baseUrlRequired")); return; }
    const provider = buildProviderPayload(form);

    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${apiBase}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, provider }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || t("modal.failedStatus", { status: res.status }));
        return;
      }
      onAdded(name);
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
      if (data.url) { window.open(data.url, "_blank"); setOauthMsg(t("modal.waitingLogin")); }
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

  return (
    <div role="dialog" aria-modal="true" aria-label={t("modal.add")} className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{preset ? t("modal.addNamed", { label: preset.label }) : t("modal.add")}</h3>
          <button className="btn btn-ghost btn-icon" aria-label={t("common.close")} onClick={onClose}><IconX /></button>
        </div>

        {!preset ? (
          <>
            <input
              ref={searchRef}
              className="input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t("modal.search")}
            />
            <div style={{ marginTop: 12, maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
              {filtered.map(p => (
                <button key={p.id} className="list-row" onClick={() => choosePreset(p)}>
                  <div>
                    <div className="title">{p.label}</div>
                    <div className="sub"><code className="chip">{p.adapter}</code>{p.note ? ` · ${p.note}` : ""}</div>
                  </div>
                  <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
                    {p.keyOptional && <span className="badge badge-green">{t("modal.badge.free")}</span>}
                    {p.auth === "oauth"
                      ? <span className="badge badge-accent">{t("modal.badge.oauth")}</span>
                      : p.auth === "forward"
                        ? <span className="badge badge-green">{t("modal.badge.codexLogin")}</span>
                        : p.auth === "local"
                          ? <span className="badge badge-amber">{t("modal.badge.local")}</span>
                          : !p.keyOptional
                            ? <span className="badge badge-muted">{t("modal.badge.apiKey")}</span>
                            : null}
                  </div>
                </button>
              ))}
              {filtered.length === 0 && <div className="muted text-control" style={{ padding: 8 }}>{t("modal.noMatch")}</div>}
            </div>
          </>
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
              {!isCustom && !isLocal && !preset.keyOptional && preset.note && (
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
                <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder={t("modal.namePlaceholder")} />
              </Field>
              {dup && <div className="text-label" style={{ color: "var(--amber)" }}>{t("modal.duplicateWarn", { name: form.name.trim() })}</div>}
              <Field label={t("modal.adapter")}>
                <select className="input" value={form.adapter} onChange={e => setForm({ ...form, adapter: e.target.value })}>
                  {["openai-responses", "openai-chat", "anthropic", "google", "azure-openai", "cursor"].map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </Field>
              <Field label={t("modal.baseUrl")}>
                <input className="input" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder={t("modal.baseUrlPlaceholder")} />
              </Field>
              {form.authMode === "forward" ? (
                <div className="text-label" style={{ color: "var(--green)", background: "var(--green-soft)", border: "1px solid var(--green)", borderRadius: "var(--radius-sm)", padding: "8px 10px" }}>
                  {t("modal.forwardHintPrefix")}{" "}
                  <code className="chip">{t("modal.forwardCredentials")}</code>{" "}
                  {t("modal.forwardHintSuffix")}
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
              <Field label={t("modal.defaultModel")}>
                <input className="input" value={form.defaultModel} onChange={e => setForm({ ...form, defaultModel: e.target.value })} placeholder={t("modal.defaultModelPlaceholder")} />
              </Field>
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
