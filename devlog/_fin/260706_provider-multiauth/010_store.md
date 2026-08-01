# 010 — Multi-account auth store

## MODIFY src/oauth/types.ts
Add:
```ts
export interface ProviderAccount {
  id: string;                 // stable short id (hash of accountId|email|refresh)
  credential: OAuthCredentials;
  needsReauth?: boolean;      // terminal refresh failure (invalid_grant / reused)
  addedAt?: number;
}
export interface ProviderAccountSet {
  activeAccountId: string;
  accounts: ProviderAccount[];
}
```

## REWRITE src/oauth/store.ts (~84 → ~190 lines)
Keep: authPath, hardenConfigDir/hardenExistingSecret/backupInvalidConfig usage,
atomicWriteFile persist, normalizeCredential (unchanged).
New internal shape: `type AuthStore = Record<string, ProviderAccountSet>`.

- `deriveAccountId(cred)`: sha256(accountId ?? email ?? refresh).slice(0,8).
- `normalizeAccountSet(raw)`: accepts (a) legacy single credential object (has
  `access` string) → wrap `{ activeAccountId: derived, accounts: [one] }`;
  (b) new shape → validate each entry's credential via normalizeCredential,
  drop invalid entries, fix activeAccountId if dangling (first account).
- Public API (existing callers keep working):
  - `getCredential(provider)` → active account's credential | null.
  - `saveCredential(provider, cred)` → upsert into accounts by derived id
    (same identity replaces credential + clears needsReauth; new identity
    appends) AND set it active. Rationale: every current caller (login,
    refresh-persist, kiro import) means "this is the credential to use now".
  - `removeCredential(provider)` → remove ONLY active account; if accounts
    remain, promote first; else delete provider key. (CLI/API logout of the
    active account; per-account removal is a new fn.)
- New API:
  - `listAccounts(provider): ProviderAccount[]`
  - `getAccountSet(provider): ProviderAccountSet | null`
  - `getAccountCredential(provider, accountId)`
  - `saveAccountCredential(provider, accountId, cred)` — persist refreshed cred
    for a SPECIFIC account WITHOUT touching activeAccountId (guardian path).
  - `setActiveAccount(provider, accountId): boolean`
  - `removeAccount(provider, accountId): boolean` (active fallback as above)
  - `markAccountNeedsReauth(provider, accountId, flag)`

## NEW tests/oauth-store-multi.test.ts
Cases: legacy→new normalize round-trip; save new identity appends + activates;
save same identity replaces; setActiveAccount switches getCredential; removeAccount
of active promotes next; last removal deletes provider; needsReauth flag persists;
invalid entries dropped.
Use `OPENCODEX_CONFIG_DIR`-style temp dir (see existing store/config tests for the
env override used by getConfigDir; mirror tests/chatgpt-oauth.test.ts setup).
