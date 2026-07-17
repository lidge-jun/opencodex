import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { IconX, IconLock, IconKey, IconExternal } from "../icons";
import { useT } from "../i18n/shared";
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

interface ModalState {
  query: string;
  preset: Preset | null;
  form: FormState | null;
  saving: boolean;
  error: string;
  oauthSupported: string[];
  oauthBusy: boolean;
  oauthMsg: string;
  oauthMsgTone: "ok" | "warn";
  manualCode: string;
  manualCodeBusy: boolean;
  manualCodeMsg: string;
  manualCodeOk: boolean;
  presets: Preset[];
}

type ModalAction =
  | { type: "set_query"; query: string }
  | { type: "set_presets"; presets: Preset[] }
  | { type: "choose_preset"; preset: Preset }
  | { type: "back" }
  | { type: "patch_form"; patch: Partial<FormState> }
  | { type: "submit_start" }
  | { type: "submit_end"; error?: string }
  | { type: "submit_finish" }
  | { type: "set_oauth_supported"; providers: string[] }
  | { type: "oauth_start" }
  | { type: "oauth_end" }
  | { type: "oauth_msg"; msg: string; tone: "ok" | "warn" }
  | { type: "manual_code_set"; value: string }
  | { type: "manual_code_start" }
  | { type: "manual_code_end"; msg: string; ok: boolean }
  | { type: "switch_to_key" }
  | { type: "switch_to_oauth" };

function formFromPreset(p: Preset): FormState {
  return {
    name: p.id === "custom" ? "" : p.id,
    adapter: p.adapter,
    baseUrl: p.baseUrl,
    authMode: p.auth,
    apiKey: "",
    defaultModel: p.defaultModel ?? "",
  };
}

function clearOAuthFields(state: ModalState): ModalState {
  return {
    ...state,
    error: "",
    oauthMsg: "",
    oauthMsgTone: "ok",
    manualCode: "",
    manualCodeMsg: "",
    manualCodeOk: true,
  };
}

function modalReducer(state: ModalState, action: ModalAction): ModalState {
  switch (action.type) {
    case "set_query":
      return { ...state, query: action.query };
    case "set_presets":
      return { ...state, presets: action.presets };
    case "choose_preset":
      return clearOAuthFields({ ...state, preset: action.preset, form: formFromPreset(action.preset) });
    case "back":
      return clearOAuthFields({ ...state, preset: null, form: null });
    case "patch_form":
      return state.form ? { ...state, form: { ...state.form, ...action.patch } } : state;
    case "submit_start":
      return { ...state, saving: true, error: "" };
    case "submit_end":
      return { ...state, saving: false, error: action.error ?? "" };
    case "submit_finish":
      return { ...state, saving: false };
    case "set_oauth_supported":
      return { ...state, oauthSupported: action.providers };
    case "oauth_start":
      return clearOAuthFields({ ...state, oauthBusy: true });
    case "oauth_end":
      return { ...state, oauthBusy: false };
    case "oauth_msg":
      return { ...state, oauthMsg: action.msg, oauthMsgTone: action.tone };
    case "manual_code_set":
      return { ...state, manualCode: action.value };
    case "manual_code_start":
      return { ...state, manualCodeBusy: true, manualCodeMsg: "" };
    case "manual_code_end":
      return { ...state, manualCodeBusy: false, manualCodeMsg: action.msg, manualCodeOk: action.ok, manualCode: action.ok ? "" : state.manualCode };
    case "switch_to_key":
      return state.form
        ? clearOAuthFields({ ...state, form: { ...state.form, authMode: "key" } })
        : state;
    case "switch_to_oauth":
      return state.form
        ? { ...state, form: { ...state.form, authMode: "oauth" }, error: "" }
        : state;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export default function AddProviderModal({
  apiBase, existingNames, onClose, onAdded,
}: {
  apiBase: string;
  existingNames: string[];
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const t = useT();
  const fallbackPresets = useMemo<Preset[]>(() => [
    { id: "custom", label: t("modal.customProvider"), adapter: "openai-chat", baseUrl: "", auth: "key" },
  ], [t]);
  const [state, dispatch] = useReducer(modalReducer, {
    query: "",
    preset: null,
    form: null,
    saving: false,
    error: "",
    oauthSupported: [],
    oauthBusy: false,
    oauthMsg: "",
    oauthMsgTone: "ok",
    manualCode: "",
    manualCodeBusy: false,
    manualCodeMsg: "",
    manualCodeOk: true,
    presets: fallbackPresets,
  });

  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);
  const loadedPresetsRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    searchRef.current?.focus();
    return () => { dialog?.close(); };
  }, []);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const { data: oauthData } = useQuery({
    queryKey: ["oauth-providers", apiBase],
    queryFn: async () => {
      const r = await fetch(`${apiBase}/api/oauth/providers`);
      if (!r.ok) throw new Error("oauth providers fetch failed");
      return r.json() as Promise<{ providers?: string[] }>;
    },
    retry: false,
  });
  const { data: presetsData } = useQuery({
    queryKey: ["provider-presets", apiBase],
    queryFn: async () => {
      const r = await fetch(`${apiBase}/api/provider-presets`);
      if (!r.ok) throw new Error("provider presets fetch failed");
      return r.json() as Promise<{ providers?: Preset[] }>;
    },
    retry: false,
  });

  useEffect(() => {
    if (oauthData) dispatch({ type: "set_oauth_supported", providers: oauthData.providers ?? [] });
  }, [oauthData]);
  useEffect(() => {
    if (presetsData && Array.isArray(presetsData.providers) && presetsData.providers.length > 0) {
      loadedPresetsRef.current = true;
      dispatch({ type: "set_presets", presets: presetsData.providers });
    }
  }, [presetsData]);
  useEffect(() => {
    if (!loadedPresetsRef.current) dispatch({ type: "set_presets", presets: fallbackPresets });
  }, [fallbackPresets]);

  const filtered = useMemo(() => {
    const q = state.query.trim().toLowerCase();
    if (!q) return state.presets;
    return state.presets.filter(p => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [state.query, state.presets]);

  const submit = async () => {
    if (!state.form) return;
    const name = state.form.name.trim();
    if (!name) { dispatch({ type: "submit_end", error: t("modal.nameRequired") }); return; }
    if (!state.form.baseUrl.trim()) { dispatch({ type: "submit_end", error: t("modal.baseUrlRequired") }); return; }
    const provider = buildProviderPayload(state.form);

    dispatch({ type: "submit_start" });
    try {
      const res = await fetch(`${apiBase}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, provider }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        dispatch({ type: "submit_end", error: d.error || t("modal.failedStatus", { status: res.status }) });
        return;
      }
      onAdded(name);
    } catch {
      dispatch({ type: "submit_end", error: t("modal.networkError") });
    } finally {
      dispatch({ type: "submit_finish" });
    }
  };

  const loginOAuth = async (providerId: string) => {
    dispatch({ type: "oauth_start" });
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await res.json();
      if (!aliveRef.current) return;
      if (!res.ok) {
        dispatch({
          type: "oauth_msg",
          tone: "warn",
          msg: data.error === "unknown oauth provider" ? t("modal.oauthComingSoonShort") : (data.error || t("modal.loginFailStart")),
        });
        return;
      }
      dispatch({
        type: "oauth_msg",
        tone: "ok",
        msg: data.url ? t("modal.waitingLogin") : (data.instructions || t("modal.loggingIn")),
      });
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (!aliveRef.current) return;
        const s = await fetch(`${apiBase}/api/oauth/status?provider=${providerId}`).then(r => r.json()).catch(() => null);
        if (!aliveRef.current) return;
        if (s?.loggedIn) { onAdded(providerId); return; }
        if (s?.error) {
          dispatch({ type: "oauth_msg", tone: "warn", msg: t("modal.loginError", { error: s.error }) });
          return;
        }
      }
      dispatch({ type: "oauth_msg", tone: "warn", msg: t("modal.loginTimeout") });
    } catch {
      if (aliveRef.current) dispatch({ type: "oauth_msg", tone: "warn", msg: t("modal.networkError") });
    } finally {
      if (aliveRef.current) dispatch({ type: "oauth_end" });
    }
  };

  const submitManualCode = async (providerId: string) => {
    const input = state.manualCode.trim();
    if (!input || state.manualCodeBusy) return;
    dispatch({ type: "manual_code_start" });
    try {
      const res = await fetch(`${apiBase}/api/oauth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, input }),
      });
      const data = await res.json().catch(() => ({}));
      if (!aliveRef.current) return;
      if (!res.ok) {
        dispatch({ type: "manual_code_end", ok: false, msg: t("prov.pasteFail", { error: data.error || res.statusText }) });
        return;
      }
      dispatch({ type: "manual_code_end", ok: true, msg: t("prov.pasteOk") });
    } catch {
      if (aliveRef.current) dispatch({ type: "manual_code_end", ok: false, msg: t("modal.networkError") });
    }
  };

  const handleDialogClose = () => onClose();
  const dup = state.form ? existingNames.includes(state.form.name.trim()) && state.form.name.trim() !== "" : false;

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-label={t("modal.add")}
      style={{ border: "none", maxWidth: "none", maxHeight: "none" }}
      onCancel={e => { e.preventDefault(); onClose(); }}
      onClose={handleDialogClose}
    >
      <div className="modal-card">
        <div className="modal-head">
          <h3>{state.preset ? t("modal.addNamed", { label: state.preset.label }) : t("modal.add")}</h3>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={t("common.close")} onClick={onClose}><IconX /></button>
        </div>

        {!state.preset ? (
          <PresetPicker
            searchRef={searchRef}
            query={state.query}
            filtered={filtered}
            onQueryChange={query => dispatch({ type: "set_query", query })}
            onChoose={preset => dispatch({ type: "choose_preset", preset })}
            t={t}
          />
        ) : state.form && (
          state.preset.auth === "oauth" && state.form.authMode === "oauth" ? (
            <OAuthPane
              preset={state.preset}
              oauthSupported={state.oauthSupported}
              oauthBusy={state.oauthBusy}
              oauthMsg={state.oauthMsg}
              oauthMsgTone={state.oauthMsgTone}
              manualCode={state.manualCode}
              manualCodeBusy={state.manualCodeBusy}
              manualCodeMsg={state.manualCodeMsg}
              manualCodeOk={state.manualCodeOk}
              onLogin={() => void loginOAuth(state.preset!.oauthProvider!)}
              onManualCodeChange={value => dispatch({ type: "manual_code_set", value })}
              onManualCodeSubmit={() => state.preset?.oauthProvider && void submitManualCode(state.preset.oauthProvider)}
              onSwitchToKey={() => dispatch({ type: "switch_to_key" })}
              onBack={() => dispatch({ type: "back" })}
              t={t}
            />
          ) : (
            <ProviderFormPane
              preset={state.preset}
              form={state.form}
              dup={dup}
              saving={state.saving}
              error={state.error}
              onPatch={patch => dispatch({ type: "patch_form", patch })}
              onSubmit={() => void submit()}
              onSwitchToOauth={() => dispatch({ type: "switch_to_oauth" })}
              onBack={() => dispatch({ type: "back" })}
              t={t}
            />
          )
        )}
      </div>
    </dialog>
  );
}

function PresetPicker({
  searchRef, query, filtered, onQueryChange, onChoose, t,
}: {
  searchRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  filtered: Preset[];
  onQueryChange: (query: string) => void;
  onChoose: (preset: Preset) => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <>
      <input
        ref={searchRef}
        className="input"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        placeholder={t("modal.search")}
      />
      <div style={{ marginTop: 12, maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {filtered.map(p => (
          <button key={p.id} type="button" className="list-row" onClick={() => onChoose(p)}>
            <div>
              <div className="title">{p.label}</div>
              <div className="sub"><code className="chip">{p.adapter}</code>{p.note ? ` · ${p.note}` : ""}</div>
            </div>
            <PresetBadges preset={p} t={t} />
          </button>
        ))}
        {filtered.length === 0 && <div className="muted text-control" style={{ padding: 8 }}>{t("modal.noMatch")}</div>}
      </div>
    </>
  );
}

function PresetBadges({ preset, t }: { preset: Preset; t: ReturnType<typeof useT> }) {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
      {preset.keyOptional && <span className="badge badge-green">{t("modal.badge.free")}</span>}
      {preset.auth === "oauth"
        ? <span className="badge badge-accent">{t("modal.badge.oauth")}</span>
        : preset.auth === "forward"
          ? <span className="badge badge-green">{t("modal.badge.codexLogin")}</span>
          : preset.auth === "local"
            ? <span className="badge badge-amber">{t("modal.badge.local")}</span>
            : !preset.keyOptional
              ? <span className="badge badge-muted">{t("modal.badge.apiKey")}</span>
              : null}
    </div>
  );
}

function OAuthPane({
  preset, oauthSupported, oauthBusy, oauthMsg, oauthMsgTone,
  manualCode, manualCodeBusy, manualCodeMsg, manualCodeOk,
  onLogin, onManualCodeChange, onManualCodeSubmit, onSwitchToKey, onBack, t,
}: {
  preset: Preset;
  oauthSupported: string[];
  oauthBusy: boolean;
  oauthMsg: string;
  oauthMsgTone: "ok" | "warn";
  manualCode: string;
  manualCodeBusy: boolean;
  manualCodeMsg: string;
  manualCodeOk: boolean;
  onLogin: () => void;
  onManualCodeChange: (value: string) => void;
  onManualCodeSubmit: () => void;
  onSwitchToKey: () => void;
  onBack: () => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="muted text-control">{preset.note ?? t("modal.oauthDefaultNote")}</div>
      {oauthSupported.includes(preset.oauthProvider ?? "") ? (
        <button type="button" className="btn btn-primary" onClick={onLogin} disabled={oauthBusy}
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
          <div className="muted text-label">{t("prov.pasteRedirectHint")}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={manualCode}
              onChange={e => onManualCodeChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && preset.oauthProvider) {
                  e.preventDefault();
                  onManualCodeSubmit();
                }
              }}
              placeholder={t("prov.pasteRedirect")}
              aria-label={t("prov.pasteRedirect")}
              disabled={manualCodeBusy}
              className="input text-label"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={manualCodeBusy || !manualCode.trim() || !preset.oauthProvider}
              onClick={onManualCodeSubmit}
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
        <button type="button" className="link-btn" onClick={onSwitchToKey}>{t("modal.useApiKeyInstead")}</button>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost" onClick={onBack}>{t("modal.back")}</button>
      </div>
    </div>
  );
}

function ProviderFormPane({
  preset, form, dup, saving, error, onPatch, onSubmit, onSwitchToOauth, onBack, t,
}: {
  preset: Preset;
  form: FormState;
  dup: boolean;
  saving: boolean;
  error: string;
  onPatch: (patch: Partial<FormState>) => void;
  onSubmit: () => void;
  onSwitchToOauth: () => void;
  onBack: () => void;
  t: ReturnType<typeof useT>;
}) {
  const isCustom = preset.id === "custom";
  const isLocal = form.authMode === "local";

  return (
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
        <input className="input" value={form.name} onChange={e => onPatch({ name: e.target.value })} placeholder={t("modal.namePlaceholder")} />
      </Field>
      {dup && <div className="text-label" style={{ color: "var(--amber)" }}>{t("modal.duplicateWarn", { name: form.name.trim() })}</div>}
      <Field label={t("modal.adapter")}>
        <select className="input" value={form.adapter} onChange={e => onPatch({ adapter: e.target.value })}>
          {["openai-responses", "openai-chat", "anthropic", "google", "azure-openai", "cursor"].map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </Field>
      <Field label={t("modal.baseUrl")}>
        <input className="input" value={form.baseUrl} onChange={e => onPatch({ baseUrl: e.target.value })} placeholder={t("modal.baseUrlPlaceholder")} />
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
            <input className="input" type="password" value={form.apiKey} onChange={e => onPatch({ apiKey: e.target.value })} placeholder={t("modal.apiKeyPlaceholder")} />
          </Field>
        </>
      )}
      <Field label={t("modal.defaultModel")}>
        <input className="input" value={form.defaultModel} onChange={e => onPatch({ defaultModel: e.target.value })} placeholder={t("modal.defaultModelPlaceholder")} />
      </Field>
      {error && <div className="text-control" role="alert" style={{ color: "var(--red)" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
        <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={saving}>{saving ? t("modal.adding") : t("modal.add")}</button>
        {preset.auth === "oauth" && <button type="button" className="link-btn" onClick={onSwitchToOauth}>{t("modal.useOauthLogin")}</button>}
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost" onClick={onBack}>{t("modal.back")}</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
