/**
 * OAuth providers where subscription login into a third-party proxy
 * (OpenCodex) carries elevated Terms-of-Service / account-action risk.
 *
 * High: provider docs/ToS explicitly restrict subscription OAuth to official apps.
 * Elevated: reverse-engineered / unofficial bridges; abuse detection may suspend access.
 */
export type OAuthTosRiskLevel = "high" | "elevated";

const HIGH_RISK = new Set(["anthropic", "google-antigravity"]);
// gemini-cli reuses Google's first-party Gemini CLI client id from a proxy rather than from the
// CLI itself — an unofficial bridge, same class as the two below. gemini-ai-studio is deliberately
// NOT listed: that subtype authorizes the operator's OWN registered OAuth client, so it carries no
// first-party-impersonation risk.
const ELEVATED_RISK = new Set(["github-copilot", "cursor", "gemini-cli"]);

export function oauthTosRisk(providerId: string): OAuthTosRiskLevel | null {
  const id = providerId.trim().toLowerCase();
  if (HIGH_RISK.has(id)) return "high";
  if (ELEVATED_RISK.has(id)) return "elevated";
  return null;
}

export function oauthTosRiskTitleKey(level: OAuthTosRiskLevel): "oauthTos.highTitle" | "oauthTos.elevatedTitle" {
  switch (level) {
    case "high":
      return "oauthTos.highTitle";
    case "elevated":
      return "oauthTos.elevatedTitle";
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

export function oauthTosRiskBodyKey(level: OAuthTosRiskLevel): "oauthTos.highBody" | "oauthTos.elevatedBody" {
  switch (level) {
    case "high":
      return "oauthTos.highBody";
    case "elevated":
      return "oauthTos.elevatedBody";
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}
