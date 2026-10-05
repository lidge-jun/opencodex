import type { AccountType } from "./account-api";
import type { OAuthHealthLabel } from "../oauth/health";

const HEALTH_LABELS: readonly OAuthHealthLabel[] = [
  "Healthy", "Rate limited", "Quota limited", "Reauthentication required",
  "Verification required", "Refresh failed", "Metadata mismatch", "Credential conflict", "Validation pending",
];

// Commands are hints, never executed. Admit only bounded, shell-safe selectors;
// arbitrary server summaries/actions may contain credentials or terminal controls.
function commandSelector(value: string): string | undefined {
  return /^[A-Za-z0-9_][A-Za-z0-9_.:@/-]{0,199}$/.test(value) ? value : undefined;
}

/** Account label for recovery lines; ids that fail the selector allowlist are never echoed. */
export function recoveryAccountLabel(id: string, display: string): string {
  return commandSelector(id) ? display : "<unprintable id>";
}

export function emptyAccountNextAction(provider?: string, type?: AccountType): string {
  const name = provider && commandSelector(provider);
  if (!name) return "Next: ocx account login <provider> (see ocx help account login)";
  return type === "api-key"
    ? `Next: ocx account add-key ${name} (pipe the key from a human-controlled stdin source; see ocx help account add-key)`
    : `Next: ocx account login ${name}`;
}

export function projectAccountHealth(
  account: { healthLabel?: unknown },
  provider: string,
  id: string,
): { health?: OAuthHealthLabel; healthAction?: string } {
  const health = HEALTH_LABELS.find(label => label === account.healthLabel);
  if (!health) return {};
  const name = commandSelector(provider);
  const selector = commandSelector(id);
  const reauth = provider === "openai" && id === "__main__"
    ? "ocx account main reauth --device"
    : name && selector ? `ocx account reauth ${name} --id ${selector}` : "ocx help account reauth";
  let healthAction: string | undefined;
  switch (health) {
    case "Reauthentication required":
    case "Refresh failed":
      healthAction = reauth;
      break;
    case "Verification required":
      healthAction = `Verify the account with the provider in a browser, then run: ${reauth}`;
      break;
    case "Credential conflict":
      healthAction = "Ensure only one proxy process writes the credential store, then run: ocx doctor";
      break;
    case "Validation pending":
      healthAction = "Wait for quota recovery, then click Refresh quotas in the dashboard Codex account pool";
      break;
    case "Rate limited":
      healthAction = "Wait for the rate-limit cooldown or use another eligible account";
      break;
    case "Quota limited":
      healthAction = "Wait for quota recovery or use another eligible account";
      break;
  }
  return { health, ...(healthAction ? { healthAction } : {}) };
}
