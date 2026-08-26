import { IconExternal, IconLink } from "../icons";
import { useT } from "../i18n/shared";
import { useCopyFeedback } from "./use-copy-feedback";

/**
 * Recovery affordance for an OAuth waiting state: the proxy already tried to
 * open the browser server-side, so this block only matters once that failed.
 * It exposes the authorization URL as selectable text, copies it, and offers a
 * manual open — the single owner for all three login surfaces (workspace panel,
 * add-provider modal, Codex account modal).
 */
export function LoginUrlBlock({ url }: { url: string }) {
  const t = useT();
  const { outcomeFor, copy } = useCopyFeedback<string>();

  if (!url) return null;

  const outcome = outcomeFor(url);

  const label = outcome === "copied"
    ? t("prov.linkCopied")
    : outcome === "unavailable"
      ? t("prov.linkCopyUnavailable")
      : t("prov.copyLink");

  return (
    <div className="login-url-block">
      <code className="login-url-block-text">{url}</code>
      <div className="login-url-block-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(url, url)}>
          <IconLink style={{ width: 13, height: 13 }} aria-hidden="true" />
          <span aria-live="polite">{label}</span>
        </button>
        <a href={url} target="_blank" rel="noreferrer" className="login-url-block-open">
          <IconExternal style={{ width: 13, height: 13 }} aria-hidden="true" /> {t("prov.didntOpen")}
        </a>
      </div>
    </div>
  );
}

/** What a login-in-progress knows about how the user should finish it. */
export type LoginHintData = {
  url?: string;
  deviceCode?: string;
  instructions?: string;
};

export type LoginHintPaste = {
  value: string;
  busy: boolean;
  message: string;
  ok: boolean;
  /** Extra submit-only gating (a missing flow id, a preset with no provider). */
  disabled?: boolean;
  /** Surface-specific "submitting" copy; defaults to the shared paste label. */
  submittingLabel?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
};

/**
 * The single renderer for a login in progress, on every surface that can start
 * one: the provider workspace panel, the add-provider modal, and the Codex
 * account modal.
 *
 * It exists because those surfaces each used to render a different subset — one
 * showed the device code but had no paste field, another had the paste field
 * and dropped the device code, and a third showed nothing at all. Which
 * affordances a user gets is a property of the provider's flow, not of which
 * dialog they happened to open.
 *
 * Order is deliberate: the device code first because it is the short thing a
 * human has to type, then the URL, then any provider prose, then the paste
 * fallback for when the browser cannot reach the loopback callback.
 */
export function LoginHint({ hint, paste }: { hint: LoginHintData; paste?: LoginHintPaste }) {
  const t = useT();
  const deviceCopy = useCopyFeedback<string>();

  const deviceCode = hint.deviceCode ?? "";
  const url = hint.url ?? "";
  // A device flow may carry no URL at all, so this must not reuse LoginUrlBlock's
  // "empty url means render nothing" rule: the code alone is still actionable.
  if (!deviceCode && !url && !hint.instructions && !paste) return null;

  const deviceOutcome = deviceCopy.outcomeFor(deviceCode);
  const deviceCopyLabel = deviceOutcome === "copied"
    ? t("prov.codeCopied")
    : deviceOutcome === "unavailable"
      ? t("prov.linkCopyUnavailable")
      : t("prov.copyCode");

  return (
    <div className="login-hint">
      {deviceCode && (
        <div className="login-hint-device pwi-device-code-wrap">
          <span className="text-label">{t("prov.deviceCode")}</span>
          <code className="login-hint-device-code pwi-device-code">{deviceCode}</code>
          <button type="button" className="btn btn-primary btn-sm"
            onClick={() => deviceCopy.copy(deviceCode, deviceCode)}>
            <span aria-live="polite">{deviceCopyLabel}</span>
          </button>
        </div>
      )}
      <LoginUrlBlock url={url} />
      {hint.instructions && <div className="muted text-label">{hint.instructions}</div>}
      {paste && (
        <div className="login-hint-paste">
          <div className="muted text-label">{t("prov.pasteRedirectHint")}</div>
          <div className="login-hint-paste-row">
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={paste.value}
              onChange={e => paste.onChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  paste.onSubmit();
                }
              }}
              placeholder={t("prov.pasteRedirect")}
              aria-label={t("prov.pasteRedirect")}
              disabled={paste.busy}
              className="input text-label login-hint-paste-input"
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={paste.busy || paste.disabled === true || !paste.value.trim()}
              onClick={paste.onSubmit}
            >
              {paste.busy ? (paste.submittingLabel ?? t("prov.pasteSubmitting")) : t("prov.pasteSubmit")}
            </button>
          </div>
          {paste.message && (
            <div className="text-label" aria-live="polite" style={{ color: paste.ok ? "var(--accent-hover)" : "var(--amber)" }}>
              {paste.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
