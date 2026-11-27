import { readUsageResponseJson, usageSummary30dResourceKey, type UsageReadMetadata } from "../usage-summary-resource";
import { UsageIncompleteNotice } from "./usage-incomplete-notice";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import ProviderNoteModal from "./provider-catalog/ProviderNoteModal";
import { isTopmostOverlayLayer } from "./overlay-layers";
import type { AccountLoginRow, AccountLoginStatus } from "./provider-catalog/ProviderCatalog";
import type { CatalogPreset } from "./provider-catalog/provider-presets";
import type { CatalogLoginHint } from "./provider-catalog/login-hint-visibility";
import { baseUrlForChoice, matchChoiceId, resolvedBaseUrlForChoice } from "../base-url-choice";
import { AddProviderOAuthPane } from "./add-provider-oauth-pane";
import { sharedLoginRow } from "./shared-login-row";
import { AddProviderFormPane } from "./add-provider-form-pane";
import { useAddProviderOAuth, type OAuthLoginCaptureOwner } from "./use-add-provider-oauth";
import type { BrowserLaunch } from "../oauth-browser-launch";
import {
  addProviderModalReducer,
  createInitialAddProviderState,
} from "./add-provider-modal-reducer";
import { captureApiTarget, isApiTargetCaptureCurrent, targetFetch, type ApiTargetCapture } from "../api";

export type ProviderConfig = ProviderPayload;

type Preset = CatalogPreset;

export default function AddProviderModal({
  apiBase, targetKey, existingNames, onClose, onAdded, initialTier, initialCustom = false,
  accountRows, accountStatus, accountBusy, accountLoginHint = null,
  accountLoginCaptures, onAccountLogin, onAccountCancelLogin, onAccountLogout, onAccountManage, onOpen,
  stackedOverlayOpen = false,
}: {
  apiBase: string;
  targetKey?: string;
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
  /** The providers page's captures for those logins; a code pasted into an Accounts row uses them (#8618). */
  accountLoginCaptures?: OAuthLoginCaptureOwner;
  onAccountLogin?: (provider: string, addAccount?: boolean) => void;
  onAccountCancelLogin?: (provider: string) => void;
  onAccountLogout?: (provider: string) => void;
  onAccountManage?: (provider: string) => void;
  onOpen?: () => void;
  /**
   * A dialog the providers page owns is open above this modal: the OAuth risk warning of an
   * Accounts-tab login, the Codex login, or a page confirmation (#8849). Escape belongs to it.
   */
  stackedOverlayOpen?: boolean;
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
  const [renderCapture] = useState<ApiTargetCapture>(() => captureApiTarget("shared", apiBase));
  // An empty string is a legacy "the caller had no logical key", not a target named "".
  // Only an explicit non-empty key is validated against the render capture; otherwise the
  // capture this modal rendered under is authoritative.
  const suppliedTargetKey = targetKey && targetKey.trim() ? targetKey : undefined;
  const renderedTargetKey = suppliedTargetKey ?? renderCapture.targetKey;
  const aliveRef = useRef(true);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // The full-note popup is owned here, not in the catalog: it has to render as a sibling
  // of this overlay, and its open state has to be visible to the Escape handler below.
  const [notePreset, setNotePreset] = useState<Preset | null>(null);
  // The unified search text is owned here for the same reason: Escape has to clear a
  // non-empty query instead of closing the dialog, and the handler that decides is this
  // component's.
  const [catalogQuery, setCatalogQuery] = useState("");

  const oauthPoll = useKeyedClientResource(
    `add-provider-oauth:${suppliedTargetKey ?? apiBase}`,
    [apiBase, suppliedTargetKey],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/oauth/providers`, { signal });
      if (!res.ok) return [] as string[];
      const data = await res.json() as { providers?: string[] };
      return data.providers ?? [];
    },
  );
  const presetsPoll = useKeyedClientResource(
    `add-provider-presets:${suppliedTargetKey ?? apiBase}`,
    [apiBase, suppliedTargetKey],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/provider-presets`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json() as { providers?: Preset[] };
      return Array.isArray(data.providers) && data.providers.length > 0 ? data.providers : null;
    },
  );
  const usagePoll = useKeyedClientResource(
    usageSummary30dResourceKey(apiBase, "all", suppliedTargetKey),
    [apiBase, suppliedTargetKey],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/usage?range=30d`, { signal });
      return await readUsageResponseJson<UsageReadMetadata & { providers?: Array<{ provider: string; requests: number }> }>(res);
    },
    { deadlineMs: 60_000 }, // shared usage-summary key: all four subscribers raise the deadline together
  );

  const oauthSupported = oauthPoll.data ?? [];
  const presets = presetsPoll.data ?? fallbackPresets;
  const presetsLoading = presetsPoll.loading;
  const usageRank = Object.fromEntries((usagePoll.data?.providers ?? []).map(row => [row.provider, row.requests]));
  const {
    preset, form, saving, error, oauthBusy, oauthMsg, oauthMsgTone, oauthUrl, oauthUrlProvider,
    oauthDeviceCode, oauthInstructions, oauthBrowserLaunch,
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
      // This listener is on `window` and does not read `defaultPrevented`, so a native
      // <dialog> cancel does not stop it. Every stacked overlay has to be named here or
      // Escape closes the whole add-provider modal out from under it.
      // Kept as a `!oauthTosPending` expression on purpose: tests/gui/oauth-tos-warning.test.ts
      // source-scans this file for that exact substring, because the guard is the only thing
      // stopping Escape from closing the modal out from under a stacked overlay.
      // Page-owned dialogs are named by `stackedOverlayOpen`: this modal cannot see their state.
      const noOverlayOpen = !oauthTosPending && !notePreset && !stackedOverlayOpen;
      if (e.key !== "Escape" || !noOverlayOpen) return;
      // Another layer already took this Escape (a confirmation above this modal cancels and
      // prevents it). Its state update can remove that layer before this listener runs, so the
      // topmost check below alone would see this modal on top and close it on the same keystroke.
      if (e.defaultPrevented) return;
      // A layer opened elsewhere on the page can sit visually above this modal (a Settings
      // confirmation's backdrop has a higher z-index); Escape is that layer's, not ours.
      if (overlayRef.current && !isTopmostOverlayLayer(overlayRef.current)) return;
      // Escape unwinds one layer at a time: the note popup, then a live search, then the
      // dialog. Closing the modal on the keystroke that was meant to clear a query throws
      // away everything the user typed into the form behind it.
      if (catalogQuery) { setCatalogQuery(""); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, oauthTosPending, notePreset, catalogQuery, stackedOverlayOpen]);

  const presetDescription = (candidate: Preset): string | undefined => {
    const key = codexPresetDescriptionKey(candidate);
    return key ? t(key) : candidate.note;
  };

  const choosePreset = (p: Preset) => {
    if (p.adapter === "agy-acp" && onAccountManage && accountRows?.some(row => row.id === p.id && row.kind === "agy")) {
      onAccountManage(p.id);
      return;
    }
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
        ...(p.id === "google-vertex" ? { googleMode: "vertex" as const, project: "", location: "" } : {}),
        allowPrivateNetwork: false,
      },
    });
  };

  /** `sharedLogin`: add a Kimi (Responses)-style row on the owner's existing login (authMode oauth). */
  const submit = async (sharedLogin = false) => {
    if (!form) return;
    if (renderedTargetKey !== renderCapture.targetKey) {
      dispatch({ type: "set-error", error: t("prov.targetChanged") });
      return;
    }
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
      if (sharedLogin) postBody.provider.authMode = "oauth";
    } catch {
      dispatch({ type: "set-error", error: t("modal.invalidPreset") });
      return;
    }

    dispatch({ type: "set-saving", saving: true });
    dispatch({ type: "set-error", error: "" });
    try {
      const res = await targetFetch(renderCapture, `${apiBase}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        dispatch({
          type: "set-error",
          error: d.error === "target_changed"
            ? t("prov.targetChanged")
            : (d.error || t("modal.failedStatus", { status: res.status })),
        });
        return;
      }
      // The POST belongs to the target that opened this modal. A completion after a
      // switch must not select the provider or show its notice on the new target.
      if (!isApiTargetCaptureCurrent(renderCapture)) {
        dispatch({ type: "set-error", error: t("prov.targetChanged") });
        return;
      }
      onAdded(postBody.name);
    } catch {
      dispatch({ type: "set-error", error: t("modal.networkError") });
    } finally {
      dispatch({ type: "set-saving", saving: false });
    }
  };

  const {
    cancelLoginOAuth,
    loginOAuth,
    submitManualCode: submitManualCodeApi,
  } = useAddProviderOAuth({ apiBase, targetKey: suppliedTargetKey, t, aliveRef, onAdded });

  const oauthSetters = {
    setOauthBusy: (busy: boolean) => dispatch({ type: "set-oauth-busy", busy }),
    setOauthMsg: (msg: string) => dispatch({ type: "set-oauth-msg", msg }),
    setOauthMsgTone: (tone: "ok" | "warn") => dispatch({ type: "set-oauth-tone", tone }),
    setOauthUrl: (url: string, providerId: string, deviceCode?: string, instructions?: string, browserLaunch?: BrowserLaunch) =>
      dispatch({ type: "set-oauth-url", url, providerId, deviceCode, instructions, browserLaunch }),
    setManualCode: (code: string) => dispatch({ type: "set-manual-code", code }),
    setManualCodeMsg: (msg: string) => dispatch({ type: "set-manual-code-msg", msg }),
    setManualCodeOk: (ok: boolean) => dispatch({ type: "set-manual-code-msg", msg: manualCodeMsg, ok }),
  };

  const dup = form ? existingNames.includes(form.name.trim()) && form.name.trim() !== "" : false;
  // Kimi (Responses) logs in through Kimi and publishes only its own row.
  const loginRow = preset ? sharedLoginRow(preset) : undefined;
  const requestLoginOAuth = (providerId: string) => {
    if (oauthBusy) return;
    if (oauthTosRisk(providerId)) {
      dispatch({ type: "set-oauth-tos-pending", providerId });
      return;
    }
    void loginOAuth(providerId, oauthSetters, false, loginRow);
  };

  // A code typed for one Accounts login belongs to that login on this target. A new login (its
  // hint changes) or a target change clears it, so it can never be submitted to the next one.
  const accountLoginIdentity = accountLoginHint
    ? [accountLoginHint.provider, accountLoginHint.url ?? "", accountLoginHint.deviceCode ?? ""].join("\u0000")
    : "";
  useEffect(() => {
    dispatch({ type: "set-manual-code", code: "" });
    dispatch({ type: "set-manual-code-msg", msg: "", ok: true });
  }, [accountLoginIdentity, apiBase, suppliedTargetKey]);

  const submitManualCode = (providerId: string, owner?: OAuthLoginCaptureOwner) => {
    void submitManualCodeApi(providerId, manualCode, manualCodeBusy, {
      setManualCodeBusy: busy => dispatch({ type: "set-manual-code-busy", busy }),
      setManualCode: code => dispatch({ type: "set-manual-code", code }),
      setManualCodeOk: ok => dispatch({ type: "set-manual-code-msg", msg: manualCodeMsg, ok }),
      setManualCodeMsg: msg => dispatch({ type: "set-manual-code-msg", msg }),
    }, owner);
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
    <div ref={overlayRef} role="dialog" aria-modal="true" aria-label={t("modal.add")} className="modal-overlay">
      <div ref={dialogRef} className="modal-card">
        <div className="modal-head">
          <h3>{preset ? t("modal.addNamed", { label: preset.label }) : t("modal.add")}</h3>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={t("common.close")} onClick={onClose}><IconX /></button>
        </div>

        {!preset && <UsageIncompleteNotice data={usagePoll.data} />}
        {!preset ? (
          <ProviderCatalog
            presets={presets}
            usageRank={usageRank}
            presetsLoading={presetsLoading}
            initialTier={initialTier}
            query={catalogQuery}
            onQueryChange={setCatalogQuery}
            onSelectPreset={p => choosePreset(p)}
            onSelectCustom={() => choosePreset(fallbackPresets[0]!)}
            onShowNote={p => setNotePreset(p)}
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
              // Accounts rows log in through the providers page, which owns their capture.
              onSubmit: providerId => { void submitManualCode(providerId, accountLoginCaptures); },
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
              oauthBrowserLaunch={oauthUrlProvider === preset.oauthProvider ? oauthBrowserLaunch : undefined}
              manualCode={manualCode}
              manualCodeBusy={manualCodeBusy}
              manualCodeMsg={manualCodeMsg}
              manualCodeOk={manualCodeOk}
              ownerLoggedIn={loginRow !== undefined && accountStatus?.[preset.oauthProvider ?? ""]?.loggedIn === true}
              saving={saving}
              error={error}
              onRequestLogin={requestLoginOAuth}
              onUseExistingLogin={() => { void submit(true); }}
              onCancelLogin={providerId => { void cancelLoginOAuth(providerId, oauthSetters, preset.label); }}
              onUseApiKeyInstead={() => {
                if (oauthBusy && preset.oauthProvider) void cancelLoginOAuth(preset.oauthProvider, oauthSetters, preset.label);
                dispatch({ type: "use-api-key-instead", form: { ...form, authMode: "key" } });
              }}
              onManualCodeChange={code => dispatch({ type: "set-manual-code", code })}
              onSubmitManualCode={providerId => { void submitManualCode(providerId); }}
              onBack={() => {
                if (oauthBusy && preset.oauthProvider) void cancelLoginOAuth(preset.oauthProvider, oauthSetters, preset.label);
                dispatch({ type: "back" });
              }}
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
          void loginOAuth(id, oauthSetters, true, loginRow);
        }}
      />
    )}
    {notePreset?.note && (
      <ProviderNoteModal
        key={notePreset.id}
        providerId={notePreset.id}
        label={notePreset.label}
        adapter={notePreset.adapter}
        note={notePreset.note}
        onClose={() => setNotePreset(null)}
      />
    )}
    </>
  );
}
