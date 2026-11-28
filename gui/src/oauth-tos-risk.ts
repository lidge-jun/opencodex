/**
 * OAuth providers where subscription login into a third-party proxy
 * (OpenCodex) carries elevated Terms-of-Service / account-action risk.
 *
 * High: provider docs/ToS explicitly restrict subscription OAuth to official apps.
 * Elevated: reverse-engineered / unofficial bridges; abuse detection may suspend access.
 */
export type OAuthTosRiskLevel = "high" | "elevated";

const HIGH_RISK = new Set(["anthropic", "anthropic2", "google-antigravity", "meta-muse"]);
const ELEVATED_RISK = new Set(["github-copilot", "cursor", "zed"]);
const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";

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

/**
 * Every copy key the warning dialog renders, chosen in one place.
 *
 * Anthropic has its own set because its conditions are specific: the connection is a
 * third-party subscription connection, the genuine Claude Code client with a person present
 * is the intended use, and other clients are better served by an API key. The shared
 * high/elevated titles stay as they are for every other provider.
 *
 * Google Antigravity has its own set and the `danger` tone because the consequence is
 * specific and severe: Google disables the whole Google account's Cloud Code Assist access
 * ("This service has been disabled in this account for violation of Terms of Service."), and
 * users of third-party tools have reported exactly that.
 */
export type OAuthTosCopyKeys = {
  tone: "warning" | "danger";
  title: "oauthTos.anthropicTitle" | "oauthTos.antigravityTitle" | ReturnType<typeof oauthTosRiskTitleKey>;
  body: "oauthTos.anthropicBody" | "oauthTos.antigravityBody" | ReturnType<typeof oauthTosRiskBodyKey>;
  conditions: "oauthTos.anthropicConditions" | "oauthTos.antigravityConditions" | null;
  saferPath: "oauthTos.anthropicSaferPath" | "oauthTos.antigravitySaferPath" | null;
  acknowledge: "oauthTos.anthropicAcknowledge" | "oauthTos.antigravityAcknowledge" | "oauthTos.acknowledge";
  continue: "oauthTos.anthropicContinue" | "oauthTos.antigravityContinue" | "oauthTos.continue";
};

export function oauthTosCopyKeys(providerId: string, level: OAuthTosRiskLevel): OAuthTosCopyKeys {
  const id = providerId.trim().toLowerCase();
  if (id === "anthropic" || id === "anthropic2") {
    return {
      tone: "warning",
      title: "oauthTos.anthropicTitle",
      body: "oauthTos.anthropicBody",
      conditions: "oauthTos.anthropicConditions",
      saferPath: "oauthTos.anthropicSaferPath",
      acknowledge: "oauthTos.anthropicAcknowledge",
      continue: "oauthTos.anthropicContinue",
    };
  }
  if (id === ANTIGRAVITY_PROVIDER_ID) {
    return {
      tone: "danger",
      title: "oauthTos.antigravityTitle",
      body: "oauthTos.antigravityBody",
      conditions: "oauthTos.antigravityConditions",
      saferPath: "oauthTos.antigravitySaferPath",
      acknowledge: "oauthTos.antigravityAcknowledge",
      continue: "oauthTos.antigravityContinue",
    };
  }
  return {
    tone: "warning",
    title: oauthTosRiskTitleKey(level),
    body: oauthTosRiskBodyKey(level),
    conditions: null,
    saferPath: null,
    acknowledge: "oauthTos.acknowledge",
    continue: "oauthTos.continue",
  };
}

/**
 * The management API refuses an Antigravity login or account import without this field
 * (src/oauth/antigravity-risk.ts). Callers pass `acknowledged` only from the warning dialog's
 * Continue, so a path that skips the dialog fails at the server instead of signing in.
 */
export function oauthRiskAcknowledgementBody(providerId: string, acknowledged: boolean): { acknowledgeAntigravityRisk?: true } {
  return acknowledged && providerId.trim().toLowerCase() === ANTIGRAVITY_PROVIDER_ID
    ? { acknowledgeAntigravityRisk: true }
    : {};
}
