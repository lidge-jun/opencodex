/**
 * Account-risk notice for Claude Desktop first-party mode.
 *
 * First-party mode sends the Claude subscription's Claude Code traffic through the local
 * interception proxy. Every surface that offers, applies or reports first-party shows this text
 * (CLI, management status, native toggle, dashboard, docs), so it has one owner and cannot drift.
 */
export const FIRST_PARTY_ACCOUNT_RISK = {
  code: "first_party_account_suspension_risk",
  message: "First-party mode sends Claude subscription traffic through a local interception proxy. "
    + "Anthropic may treat this as a violation of its terms and suspend the account. "
    + "Use it at your own risk; gateway mode is the default.",
} as const;

export type FirstPartyAccountRisk = { code: typeof FIRST_PARTY_ACCOUNT_RISK.code; message: string };

/** A fresh copy for JSON payloads, so no caller can mutate the shared constant. */
export function firstPartyAccountRisk(): FirstPartyAccountRisk {
  return { code: FIRST_PARTY_ACCOUNT_RISK.code, message: FIRST_PARTY_ACCOUNT_RISK.message };
}
