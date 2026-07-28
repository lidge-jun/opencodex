/**
 * Dashboard helpers for OAuth account health badges and localized copy.
 * Structured `health` comes from the management API; labels/summaries are
 * rendered via `t(...)` so non-English locales do not show English API text.
 */

import type { TFn, TKey } from "./i18n";
import { displayAccountId } from "./lib/privacy";

export type OAuthHealthStatus = "healthy" | "cooldown" | "reauth_required" | "warning";

export type OAuthHealthReason =
  | "rate_limit"
  | "quota"
  | "unauthorized"
  | "forbidden"
  | "refresh_failed"
  | "refresh_conflict"
  | "metadata_mismatch"
  | "stale_credentials";

export type OAuthHealthView = {
  status: OAuthHealthStatus;
  reason?: OAuthHealthReason | string;
  until?: string;
};

export type OAuthHealthBadgeTone = "ok" | "warn" | "muted";

export function oauthHealthBadgeTone(status: OAuthHealthStatus | undefined): OAuthHealthBadgeTone {
  if (status === "healthy") return "ok";
  if (status === "cooldown") return "muted";
  if (status === "reauth_required" || status === "warning") return "warn";
  return "muted";
}

export function oauthHealthBadgeClass(status: OAuthHealthStatus | undefined): string {
  const tone = oauthHealthBadgeTone(status);
  if (tone === "ok") return "badge badge-green";
  if (tone === "warn") return "badge badge-amber";
  return "badge badge-muted";
}

/** Whether the UI should offer reauthenticate (not during cooldown-only). */
export function oauthHealthShowsReauth(status: OAuthHealthStatus | undefined): boolean {
  return status === "reauth_required";
}

/**
 * Aggregate/row reauth gate: legacy `needsReauth` OR canonical health projection.
 * Health-only `reauth_required` must still demote Providers overview attention state.
 */
export function accountNeedsReauth(
  account: { needsReauth?: boolean; health?: { status?: OAuthHealthStatus } | null } | null | undefined,
): boolean {
  return Boolean(account?.needsReauth) || oauthHealthShowsReauth(account?.health?.status);
}

/** Cooldown: show wait copy; do not urge probing or immediate retry. */
export function oauthHealthIsCooldown(status: OAuthHealthStatus | undefined): boolean {
  return status === "cooldown";
}

/** Non-healthy states where copying `ocx doctor` is a useful next step. */
export function oauthHealthShowsDoctor(status: OAuthHealthStatus | undefined): boolean {
  return status === "warning" || status === "reauth_required";
}

export function oauthHealthLabelKey(health: OAuthHealthView | undefined): TKey | null {
  if (!health || health.status === "healthy") return null;
  if (health.status === "cooldown") {
    return health.reason === "rate_limit"
      ? "pws.healthLabel.rateLimited"
      : "pws.healthLabel.quotaLimited";
  }
  if (health.status === "reauth_required") {
    return health.reason === "refresh_failed"
      ? "pws.healthLabel.refreshFailed"
      : "pws.healthLabel.reauthRequired";
  }
  switch (health.reason) {
    case "refresh_conflict":
      return "pws.healthLabel.credentialConflict";
    case "metadata_mismatch":
      return "pws.healthLabel.metadataMismatch";
    case "stale_credentials":
      return "pws.healthLabel.refreshFailed";
    default:
      return "pws.healthLabel.reauthRequired";
  }
}

export function formatOAuthHealthLabel(t: TFn, health: OAuthHealthView | undefined): string | null {
  const key = oauthHealthLabelKey(health);
  return key ? t(key) : null;
}

export function formatOAuthHealthSummary(
  t: TFn,
  provider: string,
  accountId: string,
  health: OAuthHealthView | undefined,
): string | null {
  if (!health || health.status === "healthy") return null;
  const account = accountId === "__main__" ? t("codexAuth.mainAccount") : displayAccountId(accountId);
  if (health.status === "cooldown") {
    const until = health.until ? new Date(health.until).toLocaleString() : "";
    return t(
      health.reason === "rate_limit" ? "pws.healthSummary.rateLimited" : "pws.healthSummary.quotaLimited",
      { provider, account, until },
    );
  }
  if (health.status === "reauth_required") {
    return t("pws.healthSummary.reauthRequired", { provider, account });
  }
  if (health.reason === "refresh_conflict") {
    return t("pws.healthSummary.credentialConflict", { provider, account });
  }
  if (health.reason === "metadata_mismatch") {
    return t("pws.healthSummary.metadataMismatch", { provider, account });
  }
  return t("pws.healthSummary.staleCredentials", { provider, account });
}

/**
 * Safe clipboard write: never throws, and reports honestly whether the text
 * landed. The legacy `execCommand` path is not decoration — `navigator.clipboard`
 * is undefined outside a secure context, which is exactly what a LAN-bound GUI
 * (`hostname: 0.0.0.0` over plain HTTP) serves. Without the fallback, copying
 * would be permanently unavailable on that deployment.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if (write) {
    try {
      await write(text);
      return true;
    } catch {
      // Permission denied or a non-secure context: fall through to the legacy path.
    }
  }
  return copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Scope resolution moved to useCopyFeedback; this only maps an outcome to copy. */
export function doctorCopyButtonLabel(
  t: TFn,
  outcome: "copied" | "unavailable" | null | undefined,
): string {
  if (!outcome) return t("pws.copyDoctor");
  return outcome === "copied" ? t("pws.doctorCopied") : t("pws.doctorCopyUnavailable");
}

