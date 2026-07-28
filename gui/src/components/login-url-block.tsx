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
