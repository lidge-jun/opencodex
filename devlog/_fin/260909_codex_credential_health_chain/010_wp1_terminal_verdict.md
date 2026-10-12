# wp1 — persist and project the terminal validation verdict (#4120)

Class C4: OAuth credential handling, the credential store, and a health surface.

## Decision 1 — an extra optional key, not a new status value

The obvious shape for "this credential is dead" is a third value in the persisted status union
(`"ok" | "failed" | "revoked"`). It is unsafe here. `isCredentialRecord`
(`src/codex/account-store.ts:60`) admits only `undefined | "ok" | "failed"`; a record carrying an
unrecognized value fails that predicate, so `normalizeRecord` (`:74-88`) falls through to
`isCredential`, which also fails because a record has no top-level `accessToken`, and returns
`undefined`. `loadCodexAccountRecordStore` (`:96-101`) then silently omits the record. An
operator who writes a terminal verdict on 2.51 and rolls back to 2.50 would lose the whole
account entry, credential included.

An additional optional key has the opposite property: `normalizeRecord` returns
`{ ...value, refreshGrantFingerprint }`, so an unknown key is carried through untouched by a build
that has never heard of it. So the record gains:

    lastCodexValidationTerminal?: boolean;

## Decision 2 — the marker clears itself

A terminal verdict that can only be set is worse than no verdict: one spurious `invalid_grant`
from upstream would brand a live account dead forever, since background warmup is off by default
and nothing else would revisit it. The marker therefore has exactly two ways to disappear, and both
are structural rather than remembered:

- `markCodexAccountValidated` clears it explicitly, alongside the error string it already clears.
- Every credential write drops it for free. `saveCodexAccountCredential` (`:145`),
  `saveCodexAccountCredentialIfGeneration` (`:216`) and
  `commitRefreshedCodexCredentialWithAliases` (`:275`, `:303`) rebuild the record from an
  explicit field list plus `preservedValidationMetadata` (`:121-128`) and never spread
  `...current`. Keeping the new key out of that pick list is what makes a successful refresh or a
  re-login erase the verdict, which is correct: a refresh that succeeds disproves "grant revoked".

Those five sites plus the tombstone at `:324` are every record writer in the codebase —
`loadCodexAccountRecordStore` is module-private and no other module writes
`codex-accounts.json`.

## Decision 3 — the generation fence

`markCodexAccountValidationFailed` gains an options bag with `expectedGeneration` and
`terminal`, and returns whether it wrote. The guardian passes the generation it actually observed:
`record.generation` before the refresh, replaced by `token.generation` once a refresh has
committed, because a successful refresh bumps the generation and a warmup failure after it belongs
to the new credential.

A failed refresh never follows a commit inside the same call: `resolveCodexToken` returns on the
freshness shortcut (`:717-721`), on same-grant adoption (`:465-475`) and on the CAS commit
(`:975-985`), and the `TokenRefreshError` throw (`:948`) is reached only from a `!res.ok`
token response with no prior write. If a different writer replaced the credential between the
guardian's read and the locked re-read, the fence declines to write. That is a deliberate false
negative: the failure cannot be attributed to the credential the sweep observed, and refusing to
write is always safer than branding a freshly installed credential dead.

## Decision 4 — project onto the existing health member, with no GUI diff

A terminal verdict maps to `{ status: "reauth_required", reason: "refresh_failed" }`, which
already exists in `OAuthAccountHealth` (`src/oauth/health.ts:14-18`). That is not a shortcut, it
is the accurate statement: only a re-login fixes a revoked grant, and `actionFor` (`:88-95`)
already attaches `CODEX_REAUTH_ACTION` — "reauthenticate via the dashboard Codex account pool" —
for the `codex` provider.

Reusing it also means the dashboard needs no change at all. The GUI does not render the server's
`healthLabel`; it recomputes the badge from the `health` object through
`gui/src/oauth-health-display.ts`, so `reauth_required` already turns the row amber
(`codex-account-pool-cards.tsx:81,88`), prints "Reauthentication required" and shows the action.
A new warning reason would have required a GUI enum, nine i18n locales and a dashboard screenshot,
for strictly worse copy.

`collectLocalCodexEntries` (`:265-282`) currently inlines a copy of the projector's body rather
than calling it, which is how the CLI path would have silently missed this fix. It is folded onto
`projectCodexAccountHealth` so the two cannot drift again.

Precedence note: `projectOAuthAccountHealth` checks reauth before cooldown, so an account that is
both revoked and quota-cooled now reports reauth. That is the right order — telling an operator to
wait out a cooldown on a credential that will never work again is a false promise.

## Out of scope

Issue expectation 3 (revalidate stored pool credentials on a bounded schedule even with warmup
disabled) is declined here: it means a default-on inference probe, which this change is explicitly
not allowed to introduce. Showing `lastCodexValidatedAt` as a first-class dashboard column is also
deferred — it is a GUI change with no server-side defect behind it.

## Verification

Appended to existing test files, because a new test file additionally requires entries in
`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`:

- `tests/codex-integration/token-guardian.test.ts` — a revoked grant persists
  `failed` + terminal with no warmup enabled; a transient (`unknown`) refresh failure persists
  nothing; a credential replaced mid-refresh is not clobbered.
- `tests/codex-integration/codex-account-store.test.ts` — the generation fence declines a stale
  write, `markCodexAccountValidated` clears the marker, and a credential write drops it.
- `tests/oauth/oauth-health.test.ts` — a terminal record projects `reauth_required` with the
  Codex reauth action, and an ordinary record still projects healthy.
