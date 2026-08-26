import { usageSummary30dResourceKey } from "../usage-summary-resource";
import { useEffect, useMemo, useReducer, useRef } from "react";
import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { useKeyedClientResource } from "../client-resource";
import {
  buildProviderPostBody,
  codexPresetDescriptionKey,
  isReservedCodexForwardPreset,
  type ProviderPayload,
} from "../provider-payload";
import { oauthTosRisk } from "../oauth-tos-risk";
import OAuthTosWarningModal from "./OAuthTosWarningModal";
import ProviderCatalog from "./provider-catalog/ProviderCatalog";
import type { AccountLoginRow, AccountLoginStatus } from "./provider-catalog/ProviderCatalog";
import type { CatalogPreset } from "./provider-catalog/provider-presets";
import type { CatalogLoginHint } from "./provider-catalog/login-hint-visibility";
import { baseUrlForChoice, matchChoiceId, resolvedBaseUrlForChoice } from "../base-url-choice";
import { AddProviderOAuthPane } from "./add-provider-oauth-pane";
import { AddProviderFormPane } from "./add-provider-form-pane";
import { useAddProviderOAuth } from "./use-add-provider-oauth";
import {
  addProviderModalReducer,
  createInitialAddProviderState,
} from "./add-provider-modal-reducer";

export type ProviderConfig = ProviderPayload;

type Preset = CatalogPreset;

export default function AddProviderModal({
  apiBase, existingNames, onClose, onAdded, initialTier, initialCustom = false,
  accountRows, accountStatus, accountBusy, accountLoginHint = null,
  onAccountLogin, onAccountCancelLogin, onAccountLogout, onAccountManage, onOpen,
}: {
  apiBase: string;
  existingNames: string[];
  onClose: () => void;
  onAdded: (name: string) => void;
  initialTier?: "accounts" | "free" | "paid";
  initialCustom?: boolean;
  accountRows?: AccountLoginRow[];
  accountStatus?: Record<string, AccountLoginStatus>;
  accountBusy?: string | null;
  /** Login hint for an Accounts-tab login in flight, owned by the providers page. */
  accountLoginHint?: CatalogLoginHint | null;
  onAccountLogin?: (provider: string, addAccount?: boolean) => void;
  onAccountCancelLogin?: (provider: string) => void;
  onAccountLogout?: (provider: string) => void;
  onAccountManage?: (provider: string) => void;
  onOpen?: () => void;
}) {
  const t = useT();
  const fallbackPresets = useMemo<Preset[]>(() => [
    { id: "custom", label: t("modal.customProvider"), adapter: "openai-chat", baseUrl: "", auth: "key" },
  ], [t]);
  const [state, dispatch] = useReducer(
    addProviderModalReducer,
    initialCustom,
    (custom) => createInitialAddProviderState(custom, t("modal.customProvider")),
  );
  const aliveRef = useRef(true);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const oauthPoll = useKeyedClientResource(
    `add-provider-oauth:${apiBase}`,
    [apiBase],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/oauth/providers`, { signal });
      if (!res.ok) return [] as string[];
      const data = await res.json() as { providers?: string[] };
      return data.providers ?? [];
    },
  );
  const presetsPoll = useKeyedClientResource(
    `add-provider-presets:${apiBase}`,
    [apiBase],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/provider-presets`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json() as { providers?: Preset[] };
      return Array.isArray(data.providers) && data.providers.length > 0 ? data.providers : null;
    },
  );
  const usagePoll = useKeyedClientResource(
    usageSummary30dResourceKey(apiBase),
    [apiBase],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/usage?range=30d`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      return await res.json() as { providers?: Array<{ provider: string; requests: number }> };
    },
    { deadlineMs: 60_000 }, // shared usage-summary key: all four subscribers raise the deadline together
  );

  const oauthSupported = oauthPoll.data ?? [];
  const presets = presetsPoll.data ?? fallbackPresets;
  const presetsLoading = presetsPoll.loading;
  const usageRank = Object.fromEntries((usagePoll.data?.providers ?? []).map(row => [row.provider, row.requests]));
  const {
    preset, form, saving, error, oauthBusy, oauthMsg, oauthMsgTone, oauthUrl, oauthUrlProvider,
    oauthDeviceCode, oauthInstructions,
    manualCode, manualCodeBusy, manualCodeMsg, manualCodeOk, endpointChoice, oauthTosPending,
  } = state;

  useEffect(() => {
    aliveRef.current = true;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    onOpen?.();
    const dialog = dialogRef.current;
    if (dialog) {
      const focusable = dialog.querySelector<HTMLElement>(
        "input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      if (focusable) focusable.focus();
    }
    return () => {
      aliveRef.current = false;
      previousFocusRef.current?.focus();
    };
    // oxlint-disable-next-line react/react-compiler -- existing exhaustive-deps exception is intentional
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only open hook
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !oauthTosPending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, oauthTosPending]);

  const presetDescription = (candidate: Preset): string | undefined => {
    const key = codexPresetDescriptionKey(candidate);
    return key ? t(key) : candidate.note;
  };

  const choosePreset = (p: Preset) => {
    const choiceId = matchChoiceId(p.baseUrlChoices, p.baseUrl);
    dispatch({
      type: "choose-preset",
      preset: p,
      endpointChoice: choiceId,
      form: {
        name: p.id === "custom" ? "" : p.id,
        adapter: p.adapter,
        baseUrl: p.baseUrlChoices?.length
          ? baseUrlForChoice(p.baseUrlChoices, choiceId, p.baseUrl)
          : p.baseUrl,
        responsesPath: p.responsesPath,
        authMode: p.auth,
        apiKey: "",
        apiKeyTransport: undefined,
        defaultModel: p.defaultModel ?? "",
        allowPrivateNetwork: false,
      },
    });
  };

  const submit = async () => {
    if (!form) return;
    const reserved = preset ? isReservedCodexForwardPreset(preset) : false;
    const resolvedBaseUrl = preset?.baseUrlChoices?.length
      ? resolvedBaseUrlForChoice(preset.baseUrlChoices, endpointChoice, form.baseUrl)
      : form.baseUrl.trim();
    if (!reserved && !form.name.trim()) { dispatch({ type: "set-error", error: t("modal.nameRequired") }); return; }
    if (!reserved && !resolvedBaseUrl) { dispatch({ type: "set-error", error: t("modal.baseUrlRequired") }); return; }
    if (!reserved && /\{[^}]*\}/.test(resolvedBaseUrl)) { dispatch({ type: "set-error", error: t("modal.baseUrlPlaceholderError") }); return; }
    const submitForm = { ...form, baseUrl: resolvedBaseUrl };
    let postBody: { name: string; provider: ProviderPayload };
    try {
      postBody = buildProviderPostBody(preset ?? { id: "custom" }, submitForm);
    } catch {
      dispatch({ type: "set-error", error: t("modal.invalidPreset") });
      return;
    }

    dispatch({ type: "set-saving", saving: true });
    dispatch({ type: "set-error", error: "" });
    try {
      const res = await fetch(`${apiBase}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        dispatch({ type: "set-error", error: d.error || t("modal.failedStatus", { status: res.status }) });
        return;
      }
      onAdded(postBody.name);
    } catch {
      dispatch({ type: "set-error", error: t("modal.networkError") });
    } finally {
      dispatch({ type: "set-saving", saving: false });
    }
  };

  const { loginOAuth, submitManualCode: submitManualCodeApi } = useAddProviderOAuth({ apiBase, t, aliveRef, onAdded });

  const oauthSetters = {
    setOauthBusy: (busy: boolean) => dispatch({ type: "set-oauth-busy", busy }),
    setOauthMsg: (msg: string) => dispatch({ type: "set-oauth-msg", msg }),
    setOauthMsgTone: (tone: "ok" | "warn") => dispatch({ type: "set-oauth-tone", tone }),
    setOauthUrl: (url: string, providerId: string, deviceCode?: string, instructions?: string) =>
      dispatch({ type: "set-oauth-url", url, providerId, deviceCode, instructions }),
    setManualCode: (code: string) => dispatch({ type: "set-manual-code", code }),
    setManualCodeMsg: (msg: string) => dispatch({ type: "set-manual-code-msg", msg }),
    setManualCodeOk: (ok: boolean) => dispatch({ type: "set-manual-code-msg", msg: manualCodeMsg, ok }),
  };

  const dup = form ? existingNames.includes(form.name.trim()) && form.name.trim() !== "" : false;
  const requestLoginOAuth = (providerId: string) => {
    if (oauthBusy) return;
    if (oauthTosRisk(providerId)) {
      dispatch({ type: "set-oauth-tos-pending", providerId });
      return;
    }
    void loginOAuth(providerId, oauthSetters);
  };

  const submitManualCode = (providerId: string) => {
    void submitManualCodeApi(providerId, manualCode, manualCodeBusy, {
      setManualCodeBusy: busy => dispatch({ type: "set-manual-code-busy", busy }),
      setManualCode: code => dispatch({ type: "set-manual-code", code }),
      setManualCodeOk: ok => dispatch({ type: "set-manual-code-msg", msg: manualCodeMsg, ok }),
      setManualCodeMsg: msg => dispatch({ type: "set-manual-code-msg", msg }),
    });
  };

  const isCustom = preset?.id === "custom";
  const isLocal = form?.authMode === "local";
  const isReservedForward = preset ? isReservedCodexForwardPreset(preset) : false;

  return (
    <>
    {/* The backdrop must not dismiss this modal: a stray click — or a text
        selection drag that is released outside the card — would wipe every
        field the user already filled in. Close only via the × button,
        Escape, or a successful add. */}
    <div role="dialog" aria-modal="true" aria-label={t("modal.add")} className="modal-overlay">
      <div ref={dialogRef} className="modal-card">
        <div className="modal-head">
          <h3>{preset ? t("modal.addNamed", { label: preset.label }) : t("modal.add")}</h3>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={t("common.close")} onClick={onClose}><IconX /></button>
        </div>

        {!preset ? (
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
            onManage={onAccountManage}
            loginHint={accountLoginHint}
            paste={{
              value: manualCode,
              busy: manualCodeBusy,
              message: manualCodeMsg,
              ok: manualCodeOk,
              onChange: code => dispatch({ type: "set-manual-code", code }),
              onSubmit: providerId => { void submitManualCode(providerId); },
            }}
          />
        ) : form && (
          preset.auth === "oauth" && form.authMode === "oauth" ? (
            <AddProviderOAuthPane
              preset={preset}
              oauthSupported={oauthSupported}
              oauthBusy={oauthBusy}
              oauthMsg={oauthMsg}
              oauthMsgTone={oauthMsgTone}
              oauthUrl={oauthUrlProvider === preset.oauthProvider ? oauthUrl : ""}
              oauthDeviceCode={oauthUrlProvider === preset.oauthProvider ? oauthDeviceCode : ""}
              oauthInstructions={oauthUrlProvider === preset.oauthProvider ? oauthInstructions : ""}
              manualCode={manualCode}
              manualCodeBusy={manualCodeBusy}
              manualCodeMsg={manualCodeMsg}
              manualCodeOk={manualCodeOk}
              onRequestLogin={requestLoginOAuth}
              onUseApiKeyInstead={() => {
                dispatch({ type: "use-api-key-instead", form: { ...form, authMode: "key" } });
              }}
              onManualCodeChange={code => dispatch({ type: "set-manual-code", code })}
              onSubmitManualCode={providerId => { void submitManualCode(providerId); }}
              onBack={() => dispatch({ type: "back" })}
            />
          ) : (
            <AddProviderFormPane
              preset={preset}
              form={form}
              endpointChoice={endpointChoice}
              error={error}
              saving={saving}
              dup={dup}
              isCustom={isCustom}
              isLocal={isLocal}
              isReservedForward={isReservedForward}
              presetDescription={presetDescription}
              onFormChange={next => dispatch({ type: "set-form", form: next })}
              onEndpointChoiceChange={choice => dispatch({ type: "set-endpoint-choice", choice })}
              onSubmit={() => { void submit(); }}
              onUseOauthLogin={() => dispatch({ type: "use-oauth-login", form: { ...form, authMode: "oauth" } })}
              onBack={() => dispatch({ type: "back" })}
            />
          )
        )}
      </div>
    </div>
    {oauthTosPending && (
      <OAuthTosWarningModal
        key={oauthTosPending}
        providerId={oauthTosPending}
        providerLabel={preset?.label ?? oauthTosPending}
        onCancel={() => dispatch({ type: "set-oauth-tos-pending", providerId: null })}
        onContinue={() => {
          const id = oauthTosPending;
          if (!id) return;
          dispatch({ type: "set-oauth-tos-pending", providerId: null });
          void loginOAuth(id, oauthSetters);
        }}
      />
    )}
    </>
  );
}
