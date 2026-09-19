/**
 * Turn the account argument of a Codex pool command into a stored account id.
 *
 * `main` is the Codex App login. Anything else is tried as an id first and then as the
 * display alias `ocx account alias` recorded, so an operator can type the name they gave an
 * account instead of its generated id. An alias matches exactly, or case-insensitively when
 * that still names one account; two accounts sharing a name is an error, not a guess.
 */
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/account-id";
import { apiJson, type AccountDeps } from "./account-api";

/** `ocx account use <provider> auto`: clear the manual selection instead of making one. */
export const AUTO_ACCOUNT_ARGUMENT = "auto";
const MAIN_ALIAS = "main";

export type CodexAccountTarget =
  | { id: string }
  | { error: string; kind: "not_found" | "ambiguous" | "reserved" }
  | { networkDown: true; transportError?: string };

/** `auto` names no account anywhere, so an alias cannot take it either. */
export function isReservedCodexAccountWord(value: string): boolean {
  return value.toLowerCase() === AUTO_ACCOUNT_ARGUMENT;
}

export async function resolveCodexAccountTarget(
  deps: AccountDeps,
  baseUrl: string,
  requested: string,
): Promise<CodexAccountTarget> {
  if (requested === MAIN_ALIAS || requested === MAIN_CODEX_ACCOUNT_ID) return { id: MAIN_CODEX_ACCOUNT_ID };
  if (isReservedCodexAccountWord(requested)) {
    return { error: `"${requested}" is reserved; it clears the selection with \`ocx account use\` and names no account`, kind: "reserved" };
  }
  const res = await apiJson(deps, baseUrl, "GET", "/api/codex-auth/accounts");
  if (res.status === 0) return { networkDown: true, transportError: res.transportError };
  // The list is only needed to turn an alias into an id. If the proxy cannot produce it, send
  // the argument as the id it may already be and let the route answer, as the CLI always did.
  if (res.status !== 200) return { id: requested };
  const accounts = (Array.isArray(res.json.accounts) ? res.json.accounts : [])
    .filter((entry): entry is { id: string; alias?: unknown } =>
      typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string");
  if (accounts.some(account => account.id === requested)) return { id: requested };
  const exact = accounts.filter(account => account.alias === requested);
  const matches = exact.length > 0
    ? exact
    : accounts.filter(account => typeof account.alias === "string" && account.alias.toLowerCase() === requested.toLowerCase());
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length > 1) {
    return { error: `alias "${requested}" names ${matches.length} accounts; use the account id`, kind: "ambiguous" };
  }
  return { error: `Account not found: no Codex account has the id or alias "${requested}"`, kind: "not_found" };
}

export type CodexUseTarget =
  | { accountId: string | null }
  | { error: string }
  | { networkDown: true; transportError?: string };

/** The `use` argument: `auto` clears the selection, everything else resolves like any other verb. */
export async function resolveCodexUseTarget(
  deps: AccountDeps,
  baseUrl: string,
  requested: string,
): Promise<CodexUseTarget> {
  if (requested === AUTO_ACCOUNT_ARGUMENT) return { accountId: null };
  const target = await resolveCodexAccountTarget(deps, baseUrl, requested);
  if ("networkDown" in target) return target;
  if ("error" in target) return { error: target.error };
  return { accountId: target.id };
}

function displayCodexId(id: string): string {
  return id === MAIN_CODEX_ACCOUNT_ID ? MAIN_ALIAS : id;
}

/**
 * What the switch means for running work, printed to stderr after the route accepted it. The
 * route reports `pinDrainReason` only when routing would drop the pin it just recorded, so an
 * absent field means the pin survives (#4521); `null` means the pin was cleared and the pool
 * decides from here.
 */
export async function explainCodexUseOutcome(
  deps: AccountDeps,
  baseUrl: string,
  activeId: string | null,
  pinDrainReason: string | undefined,
): Promise<void> {
  if (activeId === null) {
    console.error("Takes effect from the next unbound request; running threads keep their account until it cannot serve.");
    return;
  }
  console.error("Takes effect immediately; running threads move on their next request, and in-flight requests keep the account they captured.");
  const active = await apiJson(deps, baseUrl, "GET", "/api/codex-auth/active");
  const threshold = active.status === 200 && typeof active.json.autoSwitchThreshold === "number"
    ? active.json.autoSwitchThreshold
    : undefined;
  if (pinDrainReason !== undefined) {
    // "may override" is the right caveat for a pin that is currently fine and could be
    // overtaken later. It is the wrong sentence for one the next request will discard, and
    // printing only that is what left the operator believing the account was pinned.
    const because = pinDrainReason === "quota_threshold"
      ? `is at or above the auto-switch threshold${threshold !== undefined ? ` (${threshold}%)` : ""}`
      : `cannot currently be selected (${pinDrainReason})`;
    console.error(`Note: ${displayCodexId(activeId)} ${because}, so routing releases this pin on its next request.`);
  } else if (threshold !== undefined && threshold > 0) {
    console.error(`Note: auto-switch (threshold ${threshold}%) may override this pin.`);
  }
}
