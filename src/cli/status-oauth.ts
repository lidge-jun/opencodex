import { maskAccountId } from "../lib/privacy";
import {
  CODEX_HEALTH_AUTH_FAILED_NOTE,
  CODEX_HEALTH_MANAGEMENT_API_UNAVAILABLE_NOTE,
  CODEX_HEALTH_UNAVAILABLE_NOTE,
  MASKED_ACCOUNT_FALLBACK,
  type OAuthAccountHealth,
  type OAuthCliHealthReport,
  type OAuthHealthEntry,
} from "../oauth/health";

function describeHealth(health: OAuthAccountHealth): string {
  switch (health.status) {
    case "healthy":
      return "healthy";
    case "reauth_required":
      return "reauthentication required";
    case "cooldown":
      return health.reason === "rate_limit"
        ? `rate limited until ${health.until}`
        : `quota limited until ${health.until}`;
    case "warning":
      switch (health.reason) {
        case "refresh_conflict":
          return "refresh conflict";
        case "metadata_mismatch":
          return "metadata mismatch";
        case "stale_credentials":
          return "stale credentials";
        default:
          return "warning";
      }
    default:
      return "unknown";
  }
}

function formatEntryBlock(entries: OAuthHealthEntry[]): string {
  if (entries.length === 0) return "";

  const notable = entries.filter((entry) => entry.health.status !== "healthy");
  if (notable.length === 0) return "OAuth health: ok";

  const lines = ["OAuth health: warning"];
  for (const entry of notable) {
    const masked = maskAccountId(entry.accountId) ?? MASKED_ACCOUNT_FALLBACK;
    lines.push(`  ${entry.provider}  ${masked}  ${describeHealth(entry.health)}`);
    if (entry.action) {
      lines.push(`    Action: ${entry.action}`);
    }
  }
  return lines.join("\n");
}

/** Human-readable OAuth health block for `ocx status` (redacted account ids, no tokens). */
export function formatOAuthHealthForStatus(
  input: OAuthHealthEntry[] | OAuthCliHealthReport,
): string {
  const report: OAuthCliHealthReport = Array.isArray(input)
    ? { entries: input, codexHealthSource: "management-api" }
    : input;

  const parts: string[] = [];
  switch (report.codexHealthSource) {
    case "unavailable":
      parts.push(CODEX_HEALTH_UNAVAILABLE_NOTE);
      break;
    case "management-auth-failed":
      parts.push(CODEX_HEALTH_AUTH_FAILED_NOTE);
      break;
    case "management-api-unavailable":
      parts.push(CODEX_HEALTH_MANAGEMENT_API_UNAVAILABLE_NOTE);
      break;
  }
  const oauthBlock = formatEntryBlock(report.entries);
  if (oauthBlock) parts.push(oauthBlock);
  return parts.join("\n");
}
