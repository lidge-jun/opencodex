import { useEffect, useMemo, useRef, useState } from "react";

export interface ProviderConfig {
  adapter: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  authMode?: "key" | "forward" | "oauth";
}

interface Preset {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  /** "oauth": real account login · "forward": gpt ChatGPT passthrough · "key": API key. */
  auth: "oauth" | "forward" | "key";
  /** OAuth registry id (for auth === "oauth"). */
  oauthProvider?: string;
  note?: string;
}

// `oauth` presets log in with the provider's own account (real OAuth). `forward` is the gpt
// ChatGPT-login passthrough. `key` presets need an API key.
const PRESETS: Preset[] = [
  { id: "openai", label: "OpenAI (ChatGPT login)", adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", auth: "forward", note: "Uses your codex login — no API key" },
  { id: "xai", label: "xAI Grok", adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4.3", auth: "oauth", oauthProvider: "xai", note: "Log in with your Grok account" },
  { id: "anthropic", label: "Anthropic Claude", adapter: "anthropic", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-20250514", auth: "oauth", oauthProvider: "anthropic", note: "Log in with your Claude account" },
  { id: "kimi", label: "Kimi", adapter: "openai-chat", baseUrl: "https://api.moonshot.ai/v1", defaultModel: "kimi-k2.6", auth: "oauth", oauthProvider: "kimi", note: "Log in with your Kimi account" },
  { id: "openai-apikey", label: "OpenAI (API key)", adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.5", auth: "key" },
  { id: "opencode-go", label: "opencode zen", adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", defaultModel: "kimi-k2.6", auth: "key", note: "GLM, DeepSeek, Kimi, Qwen, MiMo…" },
  { id: "openrouter", label: "OpenRouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", auth: "key" },
  { id: "groq", label: "Groq", adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", auth: "key" },
  { id: "google", label: "Google Gemini", adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", defaultModel: "gemini-3-pro", auth: "key" },
  { id: "azure-openai", label: "Azure OpenAI", adapter: "azure-openai", baseUrl: "https://{resource}.openai.azure.com/openai/deployments/{deployment}", auth: "key" },
  { id: "ollama", label: "Ollama (local)", adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", auth: "key", note: "Local — key usually blank" },
  { id: "custom", label: "Custom provider", adapter: "openai-chat", baseUrl: "", auth: "key" },
];

interface FormState {
  name: string;
  adapter: string;
  baseUrl: string;
  authMode: "key" | "forward" | "oauth";
  apiKey: string;
  defaultModel: string;
}

export default function AddProviderModal({
  apiBase, existingNames, onClose, onAdded,
}: {
  apiBase: string;
  existingNames: string[];
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [preset, setPreset] = useState<Preset | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [oauthSupported, setOauthSupported] = useState<string[]>([]);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthMsg, setOauthMsg] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);

  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => () => { aliveRef.current = false; }, []); // stop the OAuth poll if the modal unmounts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    fetch(`${apiBase}/api/oauth/providers`).then(r => r.json()).then(d => setOauthSupported(d.providers ?? [])).catch(() => {});
  }, [apiBase]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PRESETS;
    // Match by provider name/id — not adapter, since most share "openai-chat" and would all match.
    return PRESETS.filter(p => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [query]);

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
    const provider: ProviderConfig = { adapter: form.adapter.trim(), baseUrl: form.baseUrl.trim() };
    if (form.authMode === "forward") provider.authMode = "forward";
    else if (form.apiKey.trim()) provider.apiKey = form.apiKey.trim();
    if (form.defaultModel.trim()) provider.defaultModel = form.defaultModel.trim();

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
      if (!res.ok || !data.url) {
        setOauthMsg(data.error === "unknown oauth provider"
          ? "OAuth login for this provider arrives in the next update — use an API key for now."
          : (data.error || "Login failed to start"));
        return;
      }
      window.open(data.url, "_blank");
      setOauthMsg("Waiting for browser login…");
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

  return (
    <div role="dialog" aria-modal="true" aria-label="Add provider" onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, margin: 0 }}>{preset ? `Add: ${preset.label}` : "Add provider"}</h3>
          <button onClick={onClose} aria-label="Close" style={iconBtn}>×</button>
        </div>

        {!preset ? (
          <>
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search providers…"
              style={input}
            />
            <div style={{ marginTop: 12, maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
              {filtered.map(p => (
                <button key={p.id} onClick={() => choosePreset(p)} style={presetRow}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{p.label}</div>
                    <div style={{ fontSize: 12, color: "#888" }}>
                      <code>{p.adapter}</code>{p.note ? ` · ${p.note}` : ""}
                    </div>
                  </div>
                  {p.auth === "oauth"
                    ? <span style={badge("#2563eb", "#dbeafe")}>OAuth login</span>
                    : p.auth === "forward"
                      ? <span style={badge("#16a34a", "#dcfce7")}>Codex login</span>
                      : <span style={badge("#6b7280", "#f3f4f6")}>API key</span>}
                </button>
              ))}
              {filtered.length === 0 && <div style={{ fontSize: 13, color: "#888", padding: 8 }}>No match.</div>}
            </div>
          </>
        ) : form && (
          preset.auth === "oauth" && form.authMode === "oauth" ? (
            // ── Real OAuth login pane ──
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 13, color: "#555" }}>{preset.note ?? "Log in with your account — no API key needed."}</div>
              {oauthSupported.includes(preset.oauthProvider ?? "") ? (
                <button onClick={() => loginOAuth(preset.oauthProvider!)} disabled={oauthBusy}
                  style={{ ...btn("#2563eb"), opacity: oauthBusy ? 0.6 : 1, fontSize: 14, padding: "12px 16px" }}>
                  {oauthBusy ? "Waiting for browser…" : `🔐 Log in with ${preset.label}`}
                </button>
              ) : (
                <div style={{ fontSize: 13, color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "10px 12px" }}>
                  OAuth login for {preset.label} arrives in the next update. Use an API key for now.
                </div>
              )}
              {oauthMsg && <div style={{ fontSize: 12, color: /error|update|timed/.test(oauthMsg) ? "#b45309" : "#2563eb" }}>{oauthMsg}</div>}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
                <button onClick={() => { setForm({ ...form, authMode: "key" }); setOauthMsg(""); }} style={linkBtn}>Use an API key instead</button>
                <div style={{ flex: 1 }} />
                <button onClick={back} style={btn("#9ca3af")}>Back</button>
              </div>
            </div>
          ) : (
            // ── API key / Codex-forward form ──
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Field label="Provider name">
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. openrouter" style={input} />
              </Field>
              {dup && <div style={{ fontSize: 12, color: "#d97706" }}>A provider named “{form.name.trim()}” exists — it will be overwritten.</div>}
              <Field label="Adapter">
                <select value={form.adapter} onChange={e => setForm({ ...form, adapter: e.target.value })} style={input}>
                  {["openai-responses", "openai-chat", "anthropic", "google", "azure-openai"].map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </Field>
              <Field label="Base URL">
                <input value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://…" style={input} />
              </Field>
              {form.authMode === "forward" ? (
                <div style={{ fontSize: 12, color: "#16a34a", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: "8px 10px" }}>
                  No key needed — the proxy forwards your <code>codex login</code> credentials to this provider.
                </div>
              ) : (
                <Field label="API key">
                  <input type="password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-… (or $ENV_VAR)" style={input} />
                </Field>
              )}
              <Field label="Default model (optional)">
                <input value={form.defaultModel} onChange={e => setForm({ ...form, defaultModel: e.target.value })} placeholder="e.g. gpt-5.5" style={input} />
              </Field>
              {error && <div role="alert" style={{ fontSize: 13, color: "#ef4444" }}>{error}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
                <button onClick={submit} disabled={saving} style={{ ...btn("#3b82f6"), opacity: saving ? 0.6 : 1 }}>{saving ? "Adding…" : "Add provider"}</button>
                {preset.auth === "oauth" && <button onClick={() => { setForm({ ...form, authMode: "oauth" }); setError(""); }} style={linkBtn}>← Use OAuth login</button>}
                <div style={{ flex: 1 }} />
                <button onClick={back} style={btn("#9ca3af")}>Back</button>
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
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "#555", fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
  display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "8vh 16px", zIndex: 50,
};
const card: React.CSSProperties = {
  background: "#fff", borderRadius: 12, padding: 20, width: "100%", maxWidth: 520,
  boxShadow: "0 12px 40px rgba(0,0,0,0.18)", maxHeight: "84vh", overflowY: "auto",
};
const input: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e5e7eb",
  fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
};
const presetRow: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
  padding: "10px 12px", borderRadius: 8, border: "1px solid #eee", background: "#fafafa",
  cursor: "pointer", textAlign: "left", width: "100%",
};
const iconBtn: React.CSSProperties = {
  border: "none", background: "none", fontSize: 22, lineHeight: 1, cursor: "pointer", color: "#888", padding: 0,
};
const btn = (bg: string): React.CSSProperties => ({
  padding: "8px 16px", borderRadius: 6, border: "none", background: bg, color: "#fff", fontSize: 13, cursor: "pointer",
});
const linkBtn: React.CSSProperties = {
  border: "none", background: "none", color: "#2563eb", fontSize: 13, cursor: "pointer", padding: "8px 2px", textDecoration: "underline",
};
const badge = (color: string, bg: string): React.CSSProperties => ({
  fontSize: 11, fontWeight: 600, color, background: bg, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap",
});
