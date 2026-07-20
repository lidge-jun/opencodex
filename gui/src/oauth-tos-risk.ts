/**
 * OAuth providers where subscription login into a third-party proxy
 * (OpenCodex) carries elevated Terms-of-Service / account-action risk.
 *
 * High: provider docs/ToS explicitly restrict subscription OAuth to official apps.
 * Elevated: reverse-engineered / unofficial bridges; abuse detection may suspend access.
 */
export type OAuthTosRiskLevel = "high" | "elevated";

const HIGH_RISK = new Set(["anthropic", "google-antigravity"]);
const ELEVATED_RISK = new Set(["github-copilot", "cursor"]);

export function oauthTosRisk(providerId: string): OAuthTosRiskLevel | null {
  const id = providerId.trim().toLowerCase();
  if (HIGH_RISK.has(id)) return "high";
  if (ELEVATED_RISK.has(id)) return "elevated";
  return null;
}

export function oauthTosRiskTitleKey(level: OAuthTosRiskLevel): "oauthTos.highTitle" | "oauthTos.elevatedTitle" {
  return level === "high" ? "oauthTos.highTitle" : "oauthTos.elevatedTitle";
}

export function oauthTosRiskBodyKey(level: OAuthTosRiskLevel): "oauthTos.highBody" | "oauthTos.elevatedBody" {
  return level === "high" ? "oauthTos.highBody" : "oauthTos.elevatedBody";
}
