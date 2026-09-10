/**
 * Shapes shared by the catalog's Accounts rows. They live here rather than in
 * ProviderCatalog so CatalogAccountRow can import them without a cycle back through
 * the component that renders it.
 */
export type AccountLoginStatus = { loggedIn: boolean; email?: string; error?: string; needsReauth?: boolean };

export type AccountLoginRow = {
  id: string;
  label: string;
  kind: "oauth" | "key" | "codex";
  statusLabel?: string;
  /** Optional deep-link for codex/account-pool management. */
  href?: string;
};
