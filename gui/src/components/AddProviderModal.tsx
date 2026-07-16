import { useEffect, useMemo, useRef, useState } from "react";
import { IconX, IconLock, IconKey, IconExternal, IconGlobe, IconChevron, IconInfo, IconServer } from "../icons";
import { useT, type TFn } from "../i18n";
import { buildProviderPayload, type ProviderPayload } from "../provider-payload";
import { formatProviderDisplayName, providerBrandColor, providerIconSrc } from "../provider-icons";

/** How many providers fit on the first sheet (room for Free/Paid tabs + footer). */
const HOME_SLOT_COUNT = 8;

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

export type AccountLoginStatus = { loggedIn: boolean; email?: string; error?: string };
export type AccountLoginRow = {
  id: string;
  label: string;
  kind: "oauth" | "key";
  statusLabel?: string;
};

export default function AddProviderModal({
  apiBase, existingNames, onClose, onAdded, initialCustom = false,
  initialTier = "free",
  accountRows = [],
  accountStatus = {},
  accountBusy = null,
  accountLoginHint = null,
  onAccountLogin,
  onAccountCancelLogin,
  onAccountLogout,
  accountManualCode = "",
  onAccountManualCodeChange,
  onAccountManualCodeSubmit,
  accountManualCodeBusy = false,
  accountManualCodeMsg = "",
}: {
  apiBase: string;
  existingNames: string[];
  onClose: () => void;
  onAdded: (name: string) => void;
  /** Skip catalog picker and open the custom-provider form immediately. */
  initialCustom?: boolean;
  /** Opening catalog tab (Free / Paid / Logins). */
  initialTier?: "free" | "paid" | "accounts";
  /** Third-tab account login rows (oauth + key-configured), styled like the catalog. */
  accountRows?: AccountLoginRow[];
  accountStatus?: Record<string, AccountLoginStatus>;
  accountBusy?: string | null;
  accountLoginHint?: { provider: string; url?: string; instructions?: string } | null;
  onAccountLogin?: (provider: string) => void;
  /** Stop an in-progress OAuth browser wait for this account row. */
  onAccountCancelLogin?: (provider: string) => void;
  onAccountLogout?: (provider: string) => void;
  accountManualCode?: string;
  onAccountManualCodeChange?: (value: string) => void;
  onAccountManualCodeSubmit?: (provider: string) => void;
  accountManualCodeBusy?: boolean;
  accountManualCodeMsg?: string;
}) {
  const t = useT();
  const fallbackPresets = useMemo<Preset[]>(() => [
    { id: "custom", label: t("modal.customProvider"), adapter: "openai-chat", baseUrl: "", auth: "key" },
  ], [t]);
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<"free" | "paid" | "accounts">(initialTier);
  const [catalogView, setCatalogView] = useState<"home" | "browse">("home");
  const [usageRank, setUsageRank] = useState<Record<string, number>>({});
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

  useEffect(() => { if (!initialCustom && catalogView === "browse") searchRef.current?.focus(); }, [initialCustom, catalogView]);
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

  const catalog = useMemo(() => presets.filter(p => p.id !== "custom"), [presets]);

  const sortedByUsage = useMemo(() => {
    return [...catalog].sort((a, b) => {
      const ra = usageRank[a.id] ?? 0;
      const rb = usageRank[b.id] ?? 0;
      if (rb !== ra) return rb - ra;
      return a.label.localeCompare(b.label);
    });
  }, [catalog, usageRank]);

  const freePresets = useMemo(
    () => sortedByUsage.filter(isFreePreset),
    [sortedByUsage],
  );
  const paidPresets = useMemo(
    () => sortedByUsage.filter(p => !isFreePreset(p)),
    [sortedByUsage],
  );

  const tierList = tier === "paid" ? paidPresets : freePresets;

  const homeList = useMemo(
    () => tierList.slice(0, HOME_SLOT_COUNT),
    [tierList],
  );

  const browseList = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tierList;
    return tierList.filter(p => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [tierList, query]);

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
    setCatalogView("home");
    setQuery("");
  };

  const openCustom = () => {
    const custom = fallbackPresets[0]!;
    choosePreset(custom);
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
          <div className="add-prov-catalog">
            <div className="add-prov-segment add-prov-segment--3" role="tablist" aria-label={t("modal.add")}>
              <button
                type="button"
                role="tab"
                aria-selected={tier === "free"}
                className={`add-prov-segment-btn${tier === "free" ? " add-prov-segment-btn--active" : ""}`}
                onClick={() => { setTier("free"); setCatalogView("home"); setQuery(""); }}
              >
                {t("modal.tab.free")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tier === "paid"}
                className={`add-prov-segment-btn${tier === "paid" ? " add-prov-segment-btn--active" : ""}`}
                onClick={() => { setTier("paid"); setCatalogView("home"); setQuery(""); }}
              >
                {t("modal.tab.paid")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tier === "accounts"}
                className={`add-prov-segment-btn${tier === "accounts" ? " add-prov-segment-btn--active" : ""}`}
                onClick={() => { setTier("accounts"); setCatalogView("home"); setQuery(""); }}
              >
                {t("modal.tab.accounts")}
              </button>
            </div>

            <div className="add-prov-body">
            {tier === "accounts" ? (
              <div className="add-prov-list add-prov-list--browse">
                {accountRows.length === 0 && (
                  <div className="muted text-control" style={{ padding: "12px 4px" }}>{t("modal.accountsEmpty")}</div>
                )}
                {accountRows.map(row => {
                  const st = accountStatus[row.id] ?? { loggedIn: false };
                  const isBusy = accountBusy === row.id;
                  const hint = accountLoginHint?.provider === row.id ? accountLoginHint : null;
                  const icon = providerIconSrc(row.id);
                  const brand = providerBrandColor(row.id);
                  return (
                    <div key={row.id} className="add-prov-account-block">
                      <div className="add-prov-row">
                        <span className="add-prov-row-icon" aria-hidden="true" style={brand ? { color: brand } : undefined}>
                          {icon && brand
                            ? <span className="provider-icon-mask" style={{ backgroundColor: brand, WebkitMaskImage: `url(${icon})`, maskImage: `url(${icon})` }} />
                            : icon
                              ? <img src={icon} alt="" />
                              : <IconServer width={16} height={16} />}
                        </span>
                        <span className="add-prov-row-name">{formatProviderDisplayName(row.label || row.id)}</span>
                        <span className="add-prov-account-status">
                          <span className={`dot ${row.kind === "key" || st.loggedIn ? "dot-green" : "dot-muted"}`} />
                          <span className={row.kind === "key" || st.loggedIn ? "add-prov-account-status-ok" : "muted"}>
                            {row.kind === "key"
                              ? (row.statusLabel ?? t("prov.hasApiKey"))
                              : st.loggedIn
                                ? (st.email ?? t("prov.loggedIn"))
                                : t("prov.notLoggedIn")}
                          </span>
                        </span>
                        {row.kind === "oauth" ? (
                          isBusy ? (
                            <span className="add-prov-account-busy">
                              <span className="add-prov-account-busy-label">
                                <span className="spin" /> {t("prov.waitingBrowser")}
                              </span>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => onAccountCancelLogin?.(row.id)}
                              >
                                {t("common.cancel")}
                              </button>
                            </span>
                          ) : st.loggedIn ? (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onAccountLogout?.(row.id)}>
                              {t("prov.logout")}
                            </button>
                          ) : (
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => onAccountLogin?.(row.id)}>
                              <IconLock width={13} height={13} /> {t("prov.login")}
                            </button>
                          )
                        ) : (
                          <span className="add-prov-row-spacer" aria-hidden="true" />
                        )}
                      </div>
                      {hint && (hint.url || hint.instructions || isBusy) && (
                        <div className="add-prov-account-hint muted">
                          <div className="add-prov-account-hint-links">
                            {hint.url && (
                              <a href={hint.url} target="_blank" rel="noreferrer" className="link-btn" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                <IconExternal width={13} height={13} />{t("prov.didntOpen")}
                              </a>
                            )}
                            {hint.instructions && <span>{hint.instructions}</span>}
                          </div>
                          <div className="add-prov-account-paste">
                            <input
                              className="input"
                              type="text"
                              autoComplete="off"
                              spellCheck={false}
                              value={accountManualCode}
                              onChange={e => onAccountManualCodeChange?.(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  onAccountManualCodeSubmit?.(row.id);
                                }
                              }}
                              placeholder={t("prov.pasteRedirect")}
                              aria-label={t("prov.pasteRedirect")}
                              disabled={accountManualCodeBusy}
                            />
                            <button
                              className="btn btn-ghost btn-sm"
                              type="button"
                              disabled={accountManualCodeBusy || !accountManualCode.trim()}
                              onClick={() => onAccountManualCodeSubmit?.(row.id)}
                            >
                              {accountManualCodeBusy ? t("prov.pasteSubmitting") : t("prov.pasteSubmit")}
                            </button>
                          </div>
                          <div className="text-caption">{accountManualCodeMsg || t("prov.pasteRedirectHint")}</div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : catalogView === "home" ? (
              <>
                <button
                  type="button"
                  className="add-prov-browse-card"
                  onClick={() => setCatalogView("browse")}
                  disabled={tierList.length === 0}
                >
                  <span className="add-prov-browse-card-icon" aria-hidden="true">
                    <IconGlobe width={16} height={16} />
                  </span>
                  <span className="add-prov-browse-card-copy">
                    <span className="add-prov-browse-card-title">
                      {tier === "free" ? t("modal.browseFree") : t("modal.browsePaid")}
                    </span>
                  </span>
                  <IconChevron width={16} height={16} aria-hidden="true" />
                </button>
                <div className="add-prov-list">
                  {homeList.map(p => (
                    <ProviderConnectRow key={p.id} preset={p} t={t} onConnect={() => choosePreset(p)} />
                  ))}
                  {homeList.length === 0 && (
                    <div className="muted text-control" style={{ padding: "12px 4px" }}>{t("modal.noMatch")}</div>
                  )}
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="add-prov-browse-card"
                  onClick={() => { setCatalogView("home"); setQuery(""); }}
                >
                  <IconChevron width={16} height={16} aria-hidden="true" style={{ transform: "rotate(180deg)" }} />
                  <span className="add-prov-browse-card-copy">
                    <span className="add-prov-browse-card-title">{t("modal.browseBack")}</span>
                  </span>
                </button>
                <input
                  ref={searchRef}
                  className="input"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder={t("modal.search")}
                  style={{ marginBottom: 4 }}
                />
                <div className="add-prov-list add-prov-list--browse">
                  {browseList.map(p => (
                    <ProviderConnectRow key={p.id} preset={p} t={t} onConnect={() => choosePreset(p)} />
                  ))}
                  {browseList.length === 0 && (
                    <div className="muted text-control" style={{ padding: "12px 4px" }}>{t("modal.noMatch")}</div>
                  )}
                </div>
              </>
            )}
            </div>

            {/* Always show footer so Free / Paid / Accounts keep the same total height. */}
            <div className="add-prov-footer">
              <div className="add-prov-footer-copy">
                <IconInfo width={15} height={15} aria-hidden="true" />
                <div>
                  <div className="add-prov-footer-title">{t("modal.notListedTitle")}</div>
                  <div className="add-prov-footer-sub muted">{t("modal.notListedSub")}</div>
                </div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={openCustom}>
                {t("modal.connectApiKey")}
              </button>
            </div>
          </div>
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

function isFreePreset(p: Preset): boolean {
  if (p.keyOptional) return true;
  if (p.auth === "local") return true;
  try {
    const host = new URL(p.baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function authBadge(p: Preset, t: TFn): string {
  if (p.auth === "local") return t("modal.badge.local");
  if (p.auth === "oauth") return t("modal.badge.oauth");
  if (p.auth === "forward") return t("modal.badge.codexLogin");
  return t("modal.badge.api");
}

function ProviderConnectRow({
  preset, t, onConnect,
}: {
  preset: Preset;
  t: TFn;
  onConnect: () => void;
}) {
  const icon = providerIconSrc(preset.id, { adapter: preset.adapter, baseUrl: preset.baseUrl });
  const brand = providerBrandColor(preset.id);
  return (
    <div className="add-prov-row">
      <span className="add-prov-row-icon" aria-hidden="true" style={brand ? { color: brand } : undefined}>
        {icon && brand
          ? <span className="provider-icon-mask" style={{ backgroundColor: brand, WebkitMaskImage: `url(${icon})`, maskImage: `url(${icon})` }} />
          : icon
            ? <img src={icon} alt="" />
            : <IconServer width={16} height={16} />}
      </span>
      <span className="add-prov-row-name">{formatProviderDisplayName(preset.label || preset.id)}</span>
      <span className="add-prov-row-badge">{authBadge(preset, t)}</span>
      <button type="button" className="btn btn-ghost btn-sm add-prov-row-connect" onClick={onConnect}>
        {t("modal.connect")}
      </button>
    </div>
  );
}
