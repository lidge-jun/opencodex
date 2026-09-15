import type { OcxConfig } from "../../types";
import { codexModelEntitlementStateForAccount, type CodexModelEntitlementSnapshot } from "../model-entitlements";
import { codexAccountLogLabel, fallbackCodexAccountLogLabel } from "../account-label";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";

export function gatedNativeReauthSuppressionReason(args: {
  snapshot: CodexModelEntitlementSnapshot;
  slug: string;
  eligibleAccountIds?: ReadonlySet<string>;
  needsReauth: (accountId: string) => boolean;
  label: (accountId: string) => string;
}): string | undefined {
  const observed = [...args.snapshot.modelsByAccount.keys()]
    .filter(accountId => !args.eligibleAccountIds || args.eligibleAccountIds.has(accountId))
    // Only accounts that could actually have served THIS model. An account upstream positively
    // denied is not why the model is missing, and blaming it would send the operator to repair a
    // credential that was never going to help. `unknown` has to stay in: an account whose roster
    // could not be confirmed reports `unknown` rather than `granted`, and a credential stuck on
    // a failed refresh is exactly that account.
    .filter(accountId => (
      codexModelEntitlementStateForAccount(args.snapshot, accountId, args.slug) !== "denied"
    ));
  const stuck = observed.filter(accountId => args.needsReauth(accountId));
  if (stuck.length === 0) return undefined;
  const names = stuck.map(accountId => args.label(accountId)).sort().join(", ");
  return stuck.length === observed.length
    ? `every Codex account that could serve it needs reauthentication (${names})`
    : `${stuck.length} of ${observed.length} Codex accounts that could serve it need reauthentication (${names})`;
}

/** Durable, operator-facing label for a pool account id; never the raw id or the email. */
export function gatedNativeAccountLabel(config: OcxConfig, accountId: string): string {
  // Direct mode narrows eligibility to the native main credential, so this is the account most
  // likely to be named here. `codexAuthContextLogLabel` calls it "main" everywhere else; hashing
  // it into a `p`-prefixed digest would name the one account the operator cannot look up.
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return "main";
  const account = (config.codexAccounts ?? []).find(candidate => candidate.id === accountId);
  return account ? codexAccountLogLabel(account) : fallbackCodexAccountLogLabel(accountId);
}

const warnedGatedNativeSuppression = new Set<string>();

/** Test seam: the warn-once memory is process-global, so a case needs to be able to clear it. */
export function resetGatedNativeSuppressionWarningsForTests(): void {
  warnedGatedNativeSuppression.clear();
}

export function warnGatedNativeSuppressedOnce(slug: string, reason: string): void {
  const signature = `${slug}\u0000${reason}`;
  if (warnedGatedNativeSuppression.has(signature)) return;
  warnedGatedNativeSuppression.add(signature);
  console.warn(
    `[opencodex] catalog sync: ${slug} is not being offered because ${reason}. `
      + "Sign in again to restore it.",
  );
}

/**
 * Mescla o catálogo retido com os modelos visíveis e as configurações atuais,
 * incluindo os nomes nativos. Tenta preservar o backup original e usa a permissão
 * de escrita para publicar o resultado apenas se os bytes mudarem, retornando
 * a contagem de entradas roteadas e por conta, o caminho e o estado da gravação.
 */
