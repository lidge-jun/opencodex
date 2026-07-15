import { useEffect, useMemo, useRef, useState } from "react";
import { IconX, IconLock, IconKey, IconExternal } from "../icons";
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

const FALLBACK_PRESETS: Preset[] = [
  { id: "custom", label: "Custom provider", adapter: "openai-chat", baseUrl: "", auth: "key" },
];

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
  const [query, setQuery] = useState("");
  const [preset, setPreset] = useState<Preset | null>(initialCustom ? FALLBACK_PRESETS[0]! : null);
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
  const [presets, setPresets] = useState<Preset[]>(FALLBACK_PRESETS);
  const searchRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);

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
      if (Array.isArray(d.providers) && d.providers.length > 0) setPresets(d.providers);
    }).catch(() => {});
  }, [apiBase]);

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
    setError(""); setOauthMsg("");
  };

  const back = () => { setPreset(null); setForm(null); setError(""); setOauthMsg(""); };

  const submit = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) { setError("Provider name is required"); return; }
    if (!form.baseUrl.trim()) { setError("Base URL is required"); return; }
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
        setError(d.error || `Failed (${res.status})`);
        return;
      }
      onAdded(name);
    } catch {
      setError("Network error — is the proxy running?");
    } finally {
      setSaving(false);
    }
  };

  // Real OAuth login: open the provider's auth page in a new tab, poll until the proxy stores the token.
  const loginOAuth = async (providerId: string) => {
    setOauthBusy(true);
    setOauthMsg("");
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await res.json();
      if (!aliveRef.current) return;
      if (!res.ok) {
        setOauthMsg(data.error === "unknown oauth provider"
          ? "OAuth login for this provider arrives in the next update — use an API key for now."
          : (data.error || "Login failed to start"));
        return;
      }
      // A non-empty url = browser/device flow (the server also opens it). An EMPTY url with a 200 =
      // a local-token import (e.g. Anthropic's Claude Code keychain, Grok CLI) that needs no browser
      // — just poll status until the credential lands. Don't treat empty url as a failure.
      if (data.url) { window.open(data.url, "_blank"); setOauthMsg("Waiting for browser login…"); }
      else { setOauthMsg(data.instructions || "Logging in…"); }
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (!aliveRef.current) return; // modal closed → stop polling, don't fire onAdded
        const s = await fetch(`${apiBase}/api/oauth/status?provider=${providerId}`).then(r => r.json()).catch(() => null);
        if (!aliveRef.current) return;
        if (s?.loggedIn) { onAdded(providerId); return; }
        if (s?.error) { setOauthMsg(`Login error: ${s.error}`); return; }
      }
      setOauthMsg("Login timed out — try again.");
    } catch {
      if (aliveRef.current) setOauthMsg("Network error — is the proxy running?");
    } finally {
      if (aliveRef.current) setOauthBusy(false);
    }
  };

  const dup = form ? existingNames.includes(form.name.trim()) && form.name.trim() !== "" : false;
  const isCustom = preset?.id === "custom";
  const isLocal = form?.authMode === "local";

  return (
    <div role="dialog" aria-modal="true" aria-label="Add provider" className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{preset ? `Add: ${preset.label}` : "Add provider"}</h3>
          <button className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}><IconX /></button>
        </div>

        {!preset ? (
          <>
            <input
              ref={searchRef}
              className="input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search providers…"
            />
            <div style={{ marginTop: 12, maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
              {filtered.map(p => (
                <button key={p.id} className="list-row" onClick={() => choosePreset(p)}>
                  <div>
                    <div className="title">{p.label}</div>
                    <div className="sub"><code className="chip">{p.adapter}</code>{p.note ? ` · ${p.note}` : ""}</div>
                  </div>
                  <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
                    {p.keyOptional && <span className="badge badge-green">Free</span>}
                    {p.auth === "oauth"
                      ? <span className="badge badge-accent">OAuth</span>
                      : p.auth === "forward"
                        ? <span className="badge badge-green">Codex login</span>
                        : p.auth === "local"
                          ? <span className="badge badge-amber">Local</span>
                          : !p.keyOptional
                            ? <span className="badge badge-muted">API key</span>
                            : null}
                  </div>
                </button>
              ))}
              {filtered.length === 0 && <div className="muted" style={{ fontSize: 13, padding: 8 }}>No match.</div>}
            </div>
          </>
        ) : form && (
          preset.auth === "oauth" && form.authMode === "oauth" ? (
            // OAuth login pane
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="muted" style={{ fontSize: 13 }}>{preset.note ?? "Log in with your account — no API key needed."}</div>
              {oauthSupported.includes(preset.oauthProvider ?? "") ? (
                <button className="btn btn-primary" onClick={() => loginOAuth(preset.oauthProvider!)} disabled={oauthBusy}
                  style={{ width: "100%", padding: "12px 16px", fontSize: 14 }}>
                  <IconLock />{oauthBusy ? "Waiting for browser…" : `Log in with ${preset.label}`}
                </button>
              ) : (
                <div style={{ fontSize: 13, color: "var(--amber)", background: "var(--amber-soft)", border: "1px solid var(--amber)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}>
                  OAuth login for {preset.label} arrives in the next update. Use an API key for now.
                </div>
              )}
              {oauthMsg && <div style={{ fontSize: 12, color: /error|update|timed/.test(oauthMsg) ? "var(--amber)" : "var(--accent-hover)" }}>{oauthMsg}</div>}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
                <button className="link-btn" onClick={() => { setForm({ ...form, authMode: "key" }); setOauthMsg(""); }}>Use an API key instead</button>
                <div style={{ flex: 1 }} />
                <button className="btn btn-ghost" onClick={back}>Back</button>
              </div>
            </div>
          ) : (
            // API key / Codex-forward / free-tier form
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {!isCustom && !isLocal && !preset.keyOptional && preset.note && (
                <details className="setup-guide">
                  <summary>Setup guide</summary>
                  <ol style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
                    <li>Go to <a href={preset.dashboardUrl} target="_blank" rel="noreferrer">{preset.label} dashboard</a> and copy your API key</li>
                    <li>Paste it in the API key field below</li>
                    <li>Click Add provider — models are auto-discovered</li>
                  </ol>
                  {preset.note && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6, fontStyle: "italic" }}>{preset.note}</div>}
                </details>
              )}
              <Field label="Provider name">
                <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. openrouter" />
              </Field>
              {dup && <div style={{ fontSize: 12, color: "var(--amber)" }}>Provider "{form.name.trim()}" exists and will be overwritten.</div>}
              <Field label="Adapter">
                <select className="input" value={form.adapter} onChange={e => setForm({ ...form, adapter: e.target.value })}>
                  {["openai-responses", "openai-chat", "anthropic", "google", "azure-openai", "cursor"].map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </Field>
              <Field label="Base URL">
                <input className="input" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://..." />
              </Field>
              {form.authMode === "forward" ? (
                <div style={{ fontSize: 12, color: "var(--green)", background: "var(--green-soft)", border: "1px solid var(--green)", borderRadius: "var(--radius-sm)", padding: "8px 10px" }}>
                  No key needed — the proxy forwards your <code className="chip">codex login</code> credentials to this provider.
                </div>
              ) : form.authMode === "local" ? (
                <div style={{ fontSize: 12, color: "var(--amber)", background: "var(--amber-soft)", border: "1px solid var(--amber)", borderRadius: "var(--radius-sm)", padding: "8px 10px", lineHeight: 1.55 }}>
                  No API key is stored. This adds Cursor's static public model catalog for Codex, but live Cursor transport and native file/shell execution remain disabled until audited.
                </div>
              ) : preset.keyOptional ? (
                <div style={{ fontSize: 12, color: "var(--green)", background: "var(--green-soft)", border: "1px solid var(--green)", borderRadius: "var(--radius-sm)", padding: "10px 12px", lineHeight: 1.6 }}>
                  <strong>Free tier</strong> — {preset.note ?? "No API key required. Works out of the box."}
                </div>
              ) : (
                <>
                  {preset.dashboardUrl && (
                    <a href={preset.dashboardUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <IconKey style={{ width: 14, height: 14 }} />Get your {preset.label} API key<IconExternal style={{ width: 13, height: 13 }} />
                    </a>
                  )}
                  <Field label="API key">
                    <input className="input" type="password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-… (or $ENV_VAR)" />
                  </Field>
                </>
              )}
              <Field label="Default model (optional)">
                <input className="input" value={form.defaultModel} onChange={e => setForm({ ...form, defaultModel: e.target.value })} placeholder="e.g. gpt-5.5" />
              </Field>
              {error && <div role="alert" style={{ fontSize: 13, color: "var(--red)" }}>{error}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
                <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? "Adding…" : "Add provider"}</button>
                {preset.auth === "oauth" && <button className="link-btn" onClick={() => { setForm({ ...form, authMode: "oauth" }); setError(""); }}>← Use OAuth login</button>}
                <div style={{ flex: 1 }} />
                <button className="btn btn-ghost" onClick={back}>Back</button>
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
