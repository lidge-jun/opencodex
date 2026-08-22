import { useCallback, useEffect, useId, useRef, useState } from "react";
import { IconX } from "../../icons";
import { useT } from "../../i18n/shared";
import { Notice } from "../../ui";
import { REPLIT_OPENAI_PROVIDER_ID } from "../../../../src/providers/replit/constants";
import { installReplitGatewayPair, type ReplitPairProbeSuccess } from "./replit-gateway-api";
import {
  MAX_REPLIT_GATEWAY_KEY_LENGTH,
  validateGatewayKeyInput,
} from "./replit-gateway-validation";

type WizardPhase = "form" | "installing" | "success" | "error";

function ReplacePairDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    confirmRef.current?.focus();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    onCancel();
  }, [onCancel]);

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay replit-gateway-replace-dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={handleCancel}
    >
      <button
        type="button"
        className="modal-backdrop-dismiss"
        aria-label={t("replitGateway.replaceCancel")}
        tabIndex={-1}
        onClick={onCancel}
      />
      <div className="modal-card" onClick={event => event.stopPropagation()} role="document">
        <h3 id={titleId}>{t("replitGateway.replaceTitle")}</h3>
        <p id={bodyId}>{t("replitGateway.replaceBody")}</p>
        <div className="modal-actions">
          <button
            type="button"
            className="btn replit-gateway-replace-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            {t("replitGateway.replaceCancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn btn-primary replit-gateway-replace-confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            {t("replitGateway.replaceConfirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export default function ReplitGatewayWizard({
  apiBase,
  onClose,
  onInstalled,
}: {
  apiBase: string;
  onClose: () => void;
  onInstalled: (primaryProvider: string) => void;
}) {
  const t = useT();
  const titleId = useId();
  const subtitleId = useId();
  const originHintId = useId();
  const keyHintId = useId();
  const originErrorId = useId();
  const keyErrorId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const originInputRef = useRef<HTMLInputElement>(null);
  const installButtonRef = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const installGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  const [origin, setOrigin] = useState("");
  const [gatewayKey, setGatewayKey] = useState("");
  const [allowCustomDomain, setAllowCustomDomain] = useState(false);
  const [setDefault, setSetDefault] = useState(false);
  const [phase, setPhase] = useState<WizardPhase>("form");
  const [originError, setOriginError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ReplitPairProbeSuccess | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [pendingReplace, setPendingReplace] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    originInputRef.current?.focus();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (dialog?.open) dialog.close();
    };
  }, []);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    if (phase === "installing" || pendingReplace) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    onClose();
  }, [onClose, pendingReplace, phase]);

  const mapFailureMessage = useCallback((
    code: string | undefined,
    kind: string,
    fallback: string,
  ): string => {
    if (kind === "network") return t("replitGateway.errorNetwork");
    if (kind === "malformed") return t("replitGateway.errorMalformed");
    if (code === "config_busy") return t("replitGateway.errorBusy");
    if (code === "provider_collision") return t("replitGateway.errorCollision");
    return fallback || t("replitGateway.errorGeneric");
  }, [t]);

  const install = useCallback(async (replace: boolean) => {
    const trimmedOrigin = origin.trim();
    let nextOriginError: string | null = null;
    let nextKeyError: string | null = null;
    if (!trimmedOrigin) nextOriginError = t("replitGateway.originRequired");
    const keyIssue = validateGatewayKeyInput(gatewayKey);
    if (keyIssue === "empty") nextKeyError = t("replitGateway.keyRequired");
    else if (keyIssue === "too_short") nextKeyError = t("replitGateway.keyTooShort");
    else if (keyIssue === "too_long") nextKeyError = t("replitGateway.keyTooLong");
    else if (keyIssue === "invalid_chars") nextKeyError = t("replitGateway.keyInvalidChars");
    if (nextOriginError || nextKeyError) {
      setOriginError(nextOriginError);
      setKeyError(nextKeyError);
      setError(null);
      setPhase("form");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++installGenerationRef.current;

    setOriginError(null);
    setKeyError(null);
    setError(null);
    setPhase("installing");

    try {
      const result = await installReplitGatewayPair(apiBase, {
        origin: trimmedOrigin,
        gatewayKey: gatewayKey.trim(),
        allowCustomDomain,
        replace,
        setDefault,
      }, { signal: controller.signal });

      if (!mountedRef.current || generation !== installGenerationRef.current) return;
      if (!result.ok) {
        if (result.kind === "aborted") {
          setPhase("form");
          return;
        }
        const failure = result.data;
        if (result.status === 409 && failure.code === "provider_collision" && !replace) {
          setPhase("form");
          setReplaceOpen(true);
          return;
        }
        setError(mapFailureMessage(failure.code, result.kind, failure.error));
        setPhase("error");
        return;
      }
      setProbe(result.data.probe);
      setPhase("success");
      onInstalled(REPLIT_OPENAI_PROVIDER_ID);
    } catch {
      if (!mountedRef.current || generation !== installGenerationRef.current) return;
      setError(t("replitGateway.errorGeneric"));
      setPhase("error");
    } finally {
      if (mountedRef.current && generation === installGenerationRef.current) {
        setPendingReplace(false);
      }
    }
  }, [allowCustomDomain, apiBase, gatewayKey, mapFailureMessage, onInstalled, origin, setDefault, t]);

  const onInstallClick = () => { void install(false); };

  const busy = phase === "installing" || pendingReplace;
  const showForm = phase === "form" || phase === "error";

  return (
    <>
      <dialog
        ref={dialogRef}
        className="modal-overlay replit-gateway-wizard"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        onCancel={handleCancel}
      >
        <button
          type="button"
          className="modal-backdrop-dismiss"
          aria-label={t("replitGateway.close")}
          tabIndex={-1}
          disabled={busy}
          onClick={() => { if (!busy) onClose(); }}
        />
        <div className="modal-card" onClick={event => event.stopPropagation()} role="document">
          <div className="modal-head">
            <h3 id={titleId}>{t("replitGateway.title")}</h3>
            <button
              type="button"
              className="btn-icon"
              onClick={onClose}
              disabled={busy}
              aria-label={t("replitGateway.close")}
            >
              <IconX />
            </button>
          </div>
          <p id={subtitleId} className="page-sub">{t("replitGateway.subtitle")}</p>
          <p className="muted replit-gateway-companion-note">{t("replitGateway.companionNote")}</p>

          {phase === "success" && probe && (
            <div className="replit-gateway-results" aria-live="polite">
              <p>{t("replitGateway.successTitle")}</p>
              <ul>
                <li>{t("replitGateway.probeHealth", { status: String(probe.healthz.status), ms: String(probe.healthz.latencyMs) })}</li>
                <li>{t("replitGateway.probeModels", { count: String(probe.models.modelCount), ms: String(probe.models.latencyMs) })}</li>
              </ul>
            </div>
          )}

          {showForm && (
            <form
              className="replit-gateway-form"
              onSubmit={(event) => {
                event.preventDefault();
                onInstallClick();
              }}
            >
              <label htmlFor="replit-gateway-origin">{t("replitGateway.originLabel")}</label>
              <input
                ref={originInputRef}
                id="replit-gateway-origin"
                type="url"
                autoComplete="off"
                spellCheck={false}
                value={origin}
                disabled={busy}
                placeholder="https://my-app.replit.app"
                aria-invalid={originError ? true : undefined}
                aria-describedby={[originHintId, originError ? originErrorId : null].filter(Boolean).join(" ") || undefined}
                onChange={(event) => {
                  setOrigin(event.target.value);
                  if (originError) setOriginError(null);
                }}
              />
              <p id={originHintId} className="muted">{t("replitGateway.originHint")}</p>
              {originError && (
                <p id={originErrorId} className="field-error" role="alert">{originError}</p>
              )}

              <label htmlFor="replit-gateway-key">{t("replitGateway.keyLabel")}</label>
              <input
                id="replit-gateway-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_REPLIT_GATEWAY_KEY_LENGTH}
                value={gatewayKey}
                disabled={busy}
                aria-invalid={keyError ? true : undefined}
                aria-describedby={[keyHintId, keyError ? keyErrorId : null].filter(Boolean).join(" ") || undefined}
                onChange={(event) => {
                  setGatewayKey(event.target.value);
                  if (keyError) setKeyError(null);
                }}
              />
              <p id={keyHintId} className="muted">{t("replitGateway.keyHint")}</p>
              {keyError && (
                <p id={keyErrorId} className="field-error" role="alert">{keyError}</p>
              )}

              <label className="row replit-gateway-checkbox" htmlFor="replit-gateway-custom-domain">
                <input
                  id="replit-gateway-custom-domain"
                  type="checkbox"
                  checked={allowCustomDomain}
                  disabled={busy}
                  onChange={(event) => setAllowCustomDomain(event.target.checked)}
                />
                <span>{t("replitGateway.customDomainLabel")}</span>
              </label>
              <p className="muted">{t("replitGateway.customDomainHint")}</p>

              <label className="row replit-gateway-checkbox" htmlFor="replit-gateway-set-default">
                <input
                  id="replit-gateway-set-default"
                  type="checkbox"
                  checked={setDefault}
                  disabled={busy}
                  onChange={(event) => setSetDefault(event.target.checked)}
                />
                <span>{t("replitGateway.setDefaultLabel")}</span>
              </label>

              {error && <Notice tone="err">{error}</Notice>}

              <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose} disabled={busy}>{t("replitGateway.close")}</button>
                <button
                  ref={installButtonRef}
                  type="submit"
                  className="btn btn-primary replit-gateway-install"
                  disabled={busy}
                >
                  {busy ? t("replitGateway.installing") : t("replitGateway.install")}
                </button>
              </div>
            </form>
          )}

          {phase === "installing" && (
            <p aria-live="polite">{t("replitGateway.installing")}</p>
          )}

          {phase === "success" && (
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>{t("replitGateway.close")}</button>
            </div>
          )}
        </div>
      </dialog>

      {replaceOpen && (
        <ReplacePairDialog
          busy={pendingReplace}
          onCancel={() => {
            setReplaceOpen(false);
            installButtonRef.current?.focus();
          }}
          onConfirm={() => {
            setPendingReplace(true);
            void install(true).finally(() => {
              setReplaceOpen(false);
            });
          }}
        />
      )}
    </>
  );
}
