/**
 * OAuth providers where subscription login into a third-party proxy
 * (OpenCodex) carries elevated Terms-of-Service / account-action risk.
 *
 * High: provider docs/ToS explicitly restrict subscription OAuth to official apps.
 * Elevated: reverse-engineered / unofficial bridges; abuse detection may suspend access.
 */
export type OAuthTosRiskLevel = "high" | "elevated";

const HIGH_RISK = new Set(["anthropic", "google-antigravity", "meta-muse"]);
const ELEVATED_RISK = new Set(["github-copilot", "cursor", "zed"]);

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
 */
export type OAuthTosCopyKeys = {
  title: "oauthTos.anthropicTitle" | ReturnType<typeof oauthTosRiskTitleKey>;
  body: "oauthTos.anthropicBody" | ReturnType<typeof oauthTosRiskBodyKey>;
  conditions: "oauthTos.anthropicConditions" | null;
  saferPath: "oauthTos.anthropicSaferPath" | "oauthTos.saferPath" | null;
  acknowledge: "oauthTos.anthropicAcknowledge" | "oauthTos.acknowledge";
  continue: "oauthTos.anthropicContinue" | "oauthTos.continue";
};

export function oauthTosCopyKeys(providerId: string, level: OAuthTosRiskLevel): OAuthTosCopyKeys {
  const id = providerId.trim().toLowerCase();
  if (id === "anthropic") {
    return {
      title: "oauthTos.anthropicTitle",
      body: "oauthTos.anthropicBody",
      conditions: "oauthTos.anthropicConditions",
      saferPath: "oauthTos.anthropicSaferPath",
      acknowledge: "oauthTos.anthropicAcknowledge",
      continue: "oauthTos.anthropicContinue",
    };
  }
  return {
    title: oauthTosRiskTitleKey(level),
    body: oauthTosRiskBodyKey(level),
    conditions: null,
    saferPath: id === "google-antigravity" ? "oauthTos.saferPath" : null,
    acknowledge: "oauthTos.acknowledge",
    continue: "oauthTos.continue",
  };
}
