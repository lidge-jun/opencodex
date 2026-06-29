import { useEffect, useRef, useState } from "react";
import AddProviderModal from "../components/AddProviderModal";
import { Notice } from "../ui";
import { IconPlus, IconTrash, IconLock, IconExternal, IconPower } from "../icons";
import { useT } from "../i18n";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; authMode?: string; disabled?: boolean }>;
}

interface OAuthStatus { loggedIn: boolean; email?: string; error?: string }

// Friendly labels for the OAuth providers the proxy supports.
const OAUTH_LABELS: Record<string, string> = {
  xai: "xAI (Grok)",
  anthropic: "Anthropic (Claude)",
  kimi: "Kimi (Moonshot)",
};
const oauthLabel = (id: string) => OAUTH_LABELS[id] ?? id;

export default function Providers({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [config, setConfig] = useState<Config | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loginInfo, setLoginInfo] = useState<{ provider: string; url?: string; instructions?: string } | null>(null);
  const aliveRef = useRef(true);

  const notify = (msg: string, ok: boolean) => { setStatus(msg); setStatusOk(ok); };

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await res.json();
      setConfig(data);
      setDraft(JSON.stringify(data, null, 2));
    } catch {
      notify(t("prov.loadConfigFail"), false);
    }
  };

  // Load the list of OAuth-capable providers, then each one's login status.
  const fetchOauth = async () => {
    try {
      const provs: string[] = (await fetch(`${apiBase}/api/oauth/providers`).then(r => r.json())).providers ?? [];
      setOauthProviders(provs);
      const entries = await Promise.all(provs.map(async p => {
        const s = await fetch(`${apiBase}/api/oauth/status?provider=${p}`).then(r => r.json()).catch(() => ({ loggedIn: false }));
        return [p, s] as const;
      }));
      setOauthStatus(Object.fromEntries(entries));
    } catch { /* ignore */ }
  };

  useEffect(() => { fetchConfig(); fetchOauth(); }, [apiBase]);

  const saveConfig = async () => {
    try {
      const parsed = JSON.parse(draft);
      const res = await fetch(`${apiBase}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (res.ok) {
        notify(t("prov.saved"), true);
        setEditing(false);
        fetchConfig();
      } else {
        notify(t("prov.saveFailed"), false);
      }
    } catch {
      notify(t("prov.invalidJson"), false);
    }
  };

  const loginOAuth = async (provider: string) => {
    setBusy(provider);
    setStatus("");
    setLoginInfo(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error || t("prov.loginFailStart", { provider: oauthLabel(provider) }), false); return; }
      // The server opens the browser itself (popup-safe). Show the URL/device code as a fallback.
      if (data.url || data.instructions) setLoginInfo({ provider, url: data.url, instructions: data.instructions });
      // Poll until the loopback callback (or device flow) completes.
      for (let i = 0; i < 150 && aliveRef.current; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const s: OAuthStatus | null = await fetch(`${apiBase}/api/oauth/status?provider=${provider}`).then(r => r.json()).catch(() => null);
        if (!s) continue;
        if (s.loggedIn) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          notify(t("prov.loginOk", { provider: oauthLabel(provider), cmd: "ocx sync" }), true);
          setLoginInfo(null);
          fetchConfig();
          break;
        }
        if (s.error) { setOauthStatus(prev => ({ ...prev, [provider]: s })); notify(t("prov.loginError", { provider: oauthLabel(provider), error: s.error }), false); break; }
      }
    } catch {
      notify(t("prov.loginRequestFail", { provider: oauthLabel(provider) }), false);
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  const logoutOAuth = async (provider: string) => {
    await fetch(`${apiBase}/api/oauth/logout?provider=${provider}`, { method: "POST" }).catch(() => {});
    setOauthStatus(prev => ({ ...prev, [provider]: { loggedIn: false } }));
    notify(t("prov.logoutOk", { provider: oauthLabel(provider) }), true);
    fetchConfig();
  };

  const removeProvider = async (name: string) => {
    if (!window.confirm(t("prov.removeConfirm", { name }))) return;
    const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    if (res.ok) { notify(t("prov.removed", { name }), true); fetchConfig(); fetchOauth(); }
    else notify(t("prov.removeFail", { name }), false);
  };

  const setProviderDisabled = async (name: string, disabled: boolean) => {
    const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    if (res.ok) {
      notify(disabled ? t("prov.disabled", { name }) : t("prov.enabled", { name }), true);
      fetchConfig();
      fetchOauth();
      return;
    }
    const data = await res.json().catch(() => ({}));
    notify(data.error || (disabled ? t("prov.disableFail", { name }) : t("prov.enableFail", { name })), false);
  };

  if (!config) return <div className="muted">{t("prov.loadingConfig")}</div>;

  return (
    <>
      <div className="page-head">
        <h2>{t("nav.providers")}</h2>
        <div className="row">
          {editing ? (
            <>
              <button className="btn btn-primary" onClick={saveConfig}>{t("common.save")}</button>
              <button className="btn btn-ghost" onClick={() => { setEditing(false); setDraft(JSON.stringify(config, null, 2)); }}>{t("common.cancel")}</button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" onClick={() => setAdding(true)}><IconPlus />{t("prov.add")}</button>
              <button className="btn btn-ghost" onClick={() => setEditing(true)}>{t("prov.editJson")}</button>
            </>
          )}
        </div>
      </div>
      <p className="page-sub">{t("prov.subtitle")}</p>

      {status && <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>}

      {/* OAuth Login — every OAuth-capable provider, with its live login status. */}
      <div className="panel panel-accent" style={{ marginBottom: 18 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <IconLock style={{ width: 16, height: 16, color: "var(--accent)" }} />
          <span style={{ fontWeight: 600 }}>{t("prov.accountLogin")}</span>
        </div>
        <div className="stack" style={{ gap: 12 }}>
          {oauthProviders.length === 0 && <span className="muted" style={{ fontSize: 13 }}>{t("prov.noOauth")}</span>}
          {oauthProviders.map(p => {
            const st = oauthStatus[p] ?? { loggedIn: false };
            const isBusy = busy === p;
            return (
              <div key={p} className="row" style={{ flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, minWidth: 170, display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{oauthLabel(p)}</span>
                  {st.loggedIn ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--green)" }}>
                      <span className="dot dot-green" />{t("prov.loggedIn")}{st.email ? ` (${st.email})` : ""}
                    </span>
                  ) : (
                    <span className="muted">{t("prov.notLoggedIn")}</span>
                  )}
                </span>
                {st.loggedIn ? (
                  <button className="btn btn-ghost btn-sm" onClick={() => logoutOAuth(p)}>{t("prov.logout")}</button>
                ) : (
                  <button className="btn btn-primary btn-sm" onClick={() => loginOAuth(p)} disabled={isBusy}>
                    {isBusy ? <><span className="spin" />{t("prov.waitingBrowser")}</> : <><IconLock />{t("prov.loginWith", { provider: oauthLabel(p) })}</>}
                  </button>
                )}
                {loginInfo?.provider === p && (loginInfo.url || loginInfo.instructions) && (
                  <span className="muted" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {loginInfo.url && <a href={loginInfo.url} target="_blank" rel="noreferrer" className="link-btn" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><IconExternal />{t("prov.didntOpen")}</a>}
                    {loginInfo.instructions && <span>{loginInfo.instructions}</span>}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {editing ? (
        <textarea
          className="input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          style={{ height: 400 }}
        />
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
            {t("prov.port")}: <code className="chip">{config.port}</code> · {t("prov.default")}: <code className="chip">{config.defaultProvider}</code>
          </div>
          {Object.entries(config.providers).map(([name, prov]) => {
            const isDefault = name === config.defaultProvider;
            const isDisabled = prov.disabled === true;
            return (
              <div key={name} className={`card prov-card${isDisabled ? " prov-card-disabled" : ""}`}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <span style={{ fontWeight: 600 }}>{name}</span>
                    {isDefault && <span className="badge badge-primary">{t("prov.defaultBadge")}</span>}
                    {isDisabled ? <span className="badge badge-muted">{t("prov.disabledBadge")}</span> : <span className="badge badge-green">{t("prov.activeBadge")}</span>}
                    {prov.authMode === "oauth" && <span className="badge badge-accent">oauth</span>}
                    {prov.authMode === "forward" && <span className="badge badge-amber">passthrough</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    <code className="chip">{prov.adapter}</code> · {prov.baseUrl}
                    {prov.defaultModel && <> · {prov.defaultModel}</>}
                    {prov.hasApiKey && <> · {t("prov.hasApiKey")}</>}
                    {prov.hasHeaders && <> · {t("prov.hasHeaders")}</>}
                  </div>
                </div>
                <div className="provider-actions">
                  <button
                    className={`btn ${isDisabled ? "btn-primary" : "btn-ghost"} btn-sm`}
                    onClick={() => setProviderDisabled(name, !isDisabled)}
                    disabled={isDefault}
                    title={isDefault ? t("prov.defaultCannotDisable") : undefined}
                    aria-label={isDisabled ? t("prov.enableAria", { name }) : t("prov.disableAria", { name })}
                  >
                    {isDefault ? <IconLock /> : <IconPower />}
                    {isDisabled ? t("prov.enable") : t("prov.disable")}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => removeProvider(name)} aria-label={t("sub.removeAria", { m: name })}><IconTrash />{t("common.remove")}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {adding && (
        <AddProviderModal
          apiBase={apiBase}
          existingNames={Object.keys(config.providers)}
          onClose={() => setAdding(false)}
          onAdded={(name) => { setAdding(false); notify(t("prov.added", { name, cmd: "ocx sync" }), true); fetchConfig(); fetchOauth(); }}
        />
      )}
    </>
  );
}
