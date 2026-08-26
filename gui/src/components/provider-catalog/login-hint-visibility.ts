/**
 * provider-catalog/login-hint-visibility.ts
 *
 * One predicate, extracted from the catalog's JSX so its failure cases are
 * testable without a DOM. It lives beside the catalog rather than in
 * `provider-presets.ts`, which is the preset DTO / tier / search module and
 * has no business knowing about login chrome.
 */

/** Login hint carried by the providers page while an account-row login is in flight. */
export type CatalogLoginHint = {
  provider: string;
  url?: string;
  instructions?: string;
  deviceCode?: string;
};

/** The account-row kinds the catalog renders; only OAuth rows own a login hint. */
export type CatalogRowKind = "oauth" | "key" | "codex";

/**
 * Whether an account row should render the in-flight login hint.
 *
 * Two failure cases this exists to prevent:
 *
 * 1. **Cross-provider paint.** The page holds ONE hint for whichever login is
 *    in flight, and the Accounts tab renders many rows from it. A login started
 *    for one provider must never show its authorization URL under another.
 * 2. **Wrong surface entirely.** A `codex` row does not log in through
 *    `/api/oauth` at all — it opens the Codex account modal, and the page marks
 *    itself busy while enabling the OpenAI provider. A stale hint must not paint
 *    an OAuth URL onto a row whose real flow is somewhere else.
 */
export function shouldShowLoginHint(
  row: { id: string; kind: CatalogRowKind },
  busyProvider: string | null,
  hint: CatalogLoginHint | null | undefined,
): boolean {
  if (!hint) return false;
  if (row.kind !== "oauth") return false;
  if (busyProvider !== row.id) return false;
  return hint.provider === row.id;
}
