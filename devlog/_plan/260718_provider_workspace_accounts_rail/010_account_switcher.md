# Work phase 010 — workspace account tab

## Outcome

Expose the already implemented generic OAuth, API-key, and canonical Codex account managers as a first-class, accessible workspace detail tab. Make account list/switch state authoritative under failure and concurrent refresh.

## P stale check — 2026-07-18

- `34e34b4..HEAD` contains no production-source change; all target files remain clean relative to the roadmap lock.
- Workspace still omits `oauth`, `accounts`, `keys`, load/busy state, and handlers at `Providers.tsx:464-480`.
- Generic OAuth and Codex account route/store contracts remain unchanged; no backend diff is required.
- The new pure auth-surface file and focused auth test are still absent as expected.
- The plan remains implementation-ready with one clarified constraint from A: identity-less one-slot providers render their actual current login without being described as a multi-account pool.

## Scope boundary

### IN

- `gui/src/pages/Providers.tsx`
- `gui/src/provider-workspace/auth.ts` (new pure auth-surface owner)
- `gui/src/components/provider-workspace/types.ts`
- `gui/src/components/provider-workspace/ProviderDetails.tsx`
- `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`
- `gui/src/components/CodexAccountPool.tsx`
- `gui/src/styles/provider-workspace-settings.css`
- `gui/src/i18n/{en,ko,de,zh}.ts`
- `tests/provider-workspace-auth.test.ts` (new)
- existing OAuth/Codex API and workspace tests

### OUT

- Server account routes/stores unless a failing contract test proves a server defect.
- Provider deletion behavior, automatic switching policy, quota algorithms, login protocol internals, classic card redesign, or new dependencies.

## Exact diff plan

### NEW `gui/src/provider-workspace/auth.ts`

- Define a narrow `ProviderAuthSurface = "codex-accounts" | "oauth-accounts" | "api-keys" | null`.
- Implement `providerAuthSurface(item)` by reusing `isAccountProvider(item.name, item)` and `isLocalProvider(item)`.
- Canonical OpenAI forward maps to `codex-accounts`; non-canonical forward maps to `null`; OAuth maps to `oauth-accounts`; effective key-auth maps to `api-keys`; local/no-auth maps to `null`.
- Add one safe account-label helper that returns the already-masked email or a localized ordinal derived from the account's position. It never falls back to the opaque account id.
- No network/UI state belongs in this module.

### MODIFY `gui/src/components/provider-workspace/types.ts`

- Add `AccountLoadState = "idle" | "loading" | "ready" | "error"`.
- Extend `ProviderAuthHandlers` with optional retry and async-compatible return signatures without breaking existing callers.
- Keep wire rows credential-free; do not add raw token/account fields.

### MODIFY `gui/src/pages/Providers.tsx`

- Add per-provider account load state, per-provider request-generation refs, and `{ provider, accountId } | null` switching state.
- Replace the all-at-once `Object.fromEntries` account load with per-provider generation-bound commits and functional map merges so subset refresh cannot erase other providers.
- Check `response.ok`; map failure to `error`; never treat failed JSON as an empty successful account set.
- Wrap generic account switch in `try/catch/finally`, block duplicate switches, reject `needsReauth`, and preserve the old visible active row until the authoritative list reload succeeds.
- On success refresh only the switched provider account set, OAuth status, and forced quota. On failure leave selection untouched and surface localized retryable status.
- Extract the API-key request into `(provider, key) => Promise<boolean>` and keep classic `newKeyValue` state in its wrapper.
- Pass `oauth`, `accounts`, `keys`, load state, switching id, busy/login hint, and existing handlers into workspace `ProviderDetails`.
- Use the shared safe account label for switch success/failure and remove confirmation/notification so page-level notices cannot leak an opaque id.
- Keep account handler object stable via direct object construction or memoization only if measured; do not create a global store.

### MODIFY `gui/src/components/provider-workspace/ProviderDetails.tsx`

- Extend `Tab` with `accounts`.
- Derive the auth surface once and insert a dynamic tab: `Accounts` for Codex/OAuth, `API keys` for key-auth. Omit it for no-op surfaces.
- Move `ProviderAuthPanel` out of Settings and render it only in the new panel.
- Add `key={item.name}` at the workspace call boundary so tab/dirty state resets when a different provider is selected; do not retain a now-invalid Accounts tab across providers.
- Add stable tab/panel ids, `aria-controls`, `aria-labelledby`, roving `tabIndex`, and ArrowLeft/ArrowRight/Home/End activation.
- If provider data changes and the current tab no longer exists, return to Overview without an effect-synchronized derived state.
- Preserve the unsaved-Settings leave confirmation when moving to Accounts.

### MODIFY `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`

- Use `providerAuthSurface`; embed `CodexAccountPool` only for `codex-accounts`.
- Treat a non-empty authoritative account list as logged in even when the independently fetched OAuth status is stale or failed; the two requests must not produce a contradictory “not logged in” header above active rows.
- Render loading, load-error + retry, loaded-empty, one, many, reauth, and switching states with text and ARIA status, not color alone.
- Do not describe a one-row identity-less provider as a multi-account pool. The panel may show the current login and re-login action while the actual returned account count remains one.
- Keep active rows focusable and expose `aria-current`/selected text rather than disabling the active row.
- Disable mutation on pending or `needsReauth` rows; expose a recovery/add-account action.
- Replace `account.email ?? account.id` with masked email or localized ordinal fallback; titles/aria labels follow the same safe label.
- Give remove buttons translated accessible names and preserve the separate-button structure.

### MODIFY `gui/src/components/CodexAccountPool.tsx`

- Add initial/refresh load state, request generation, and switching id.
- Require both list and active responses to be `ok`; ignore superseded loads.
- For active PUT, check non-2xx, keep the old active state on failure, announce the error, and on success consume the returned active id then perform an authoritative refresh.
- Use masked email/main-account copy in switch/remove feedback; never place the Codex pool id in a confirmation or toast.
- Prevent interval refresh from overwriting a newer switch; keep the documented “next session” semantics.
- Do not change add/remove/reset-credit or auto-switch business rules.

### MODIFY `gui/src/styles/provider-workspace-settings.css`

- Add account panel/loading/error/empty/switching styles using existing spacing, type, color, radius, and motion tokens only.
- Ensure email/labels use `min-width:0`, ellipsis, and title; actions remain reachable at mobile touch size.
- Add visible focus and pending treatment without changing layout dimensions.

### MODIFY locale files

- Add `pws.tab.accounts`, account loading/failure/retry/empty/switching/ordinal labels, and Codex load/switch failure copy in all four locale files.
- Korean uses short action-oriented B2B wording; buttons/tabs have no periods.

### NEW `tests/provider-workspace-auth.test.ts`

- RED before production edits: auth-surface tests for canonical OpenAI, custom forward, OAuth, key, optional/no-key, and local providers.
- Add source-contract assertions only for the integration seam that cannot be imported without a DOM harness: workspace passes account rows/state/handlers and ProviderDetails owns an Accounts panel. Do not replace browser behavior proof with source assertions.
- Classify all test edits as required; no skips, threshold changes, or assertion deletions.

## Activation matrix

| Branch | Trigger | Observable evidence |
|---|---|---|
| loading | delayed GET | loading status; controls absent/disabled |
| empty | 200 + empty list | explanatory empty state + login/add action |
| one | one active summary | one labeled current row; no raw id |
| many | Anthropic 2 / Codex 4 live rows | exactly one selected/current; others switchable |
| reauth | fixture `needsReauth=true` | visible warning; switch blocked; recovery action |
| HTTP failure | 404/500 PUT | old active row remains; alert; controls recover |
| network failure | rejected fetch | no unhandled rejection; old active remains |
| stale GET | old load resolves after switch refresh | generation guard drops old result |
| custom forward | noncanonical forward provider | no Codex pool/tab |
| provider change | Accounts tab active, then select local/no-auth provider | detail remounts on Overview; no stale panel/dirty state |
| status race | account GET succeeds while OAuth status is stale false | active account rows and logged-in summary agree |
| safe fallback | account summary has no email | localized ordinal in row, confirm, toast, title, and aria; id absent |
| keyboard tabs | Accounts tab with arrows/Home/End | focus and selected panel move together |
| live switch | switch non-active Anthropic/Codex account | network PUT, selected state changes after refresh, original id restored at teardown |

## Verification

```sh
bun test --isolate tests/provider-workspace-auth.test.ts tests/oauth-accounts-api.test.ts tests/oauth-store-multi.test.ts tests/oauth-public-surface.test.ts tests/codex-auth-api.test.ts tests/provider-workspace-data.test.ts tests/provider-workspace-state.test.ts
bun run typecheck
cd gui && bun run lint:i18n
cd gui && bun run build
bun run privacy:scan
```

Browser evidence must cover generic OAuth and canonical Codex account panels, switch success/failure, refresh persistence, keyboard tabs, and restoration of the original live active IDs.

## B implementation receipt — 2026-07-18

- Added the pure auth-surface classifier and safe masked-email/ordinal account label. The focused test was observed RED on the missing module, then GREEN at `8 pass / 0 fail` after implementation and integration assertions.
- Workspace details now receive provider-scoped OAuth rows, key rows, load state, switching identity, login hints, and mutation handlers. The detail remounts by provider name.
- Authentication moved from Settings into a dynamic Accounts/API keys tab with linked tab/panel semantics and Arrow/Home/End keyboard activation.
- Generic account reads commit by provider and request generation. Failed or stale reads no longer erase unrelated providers; switches block duplicate/reauth mutations, check non-2xx, refresh authoritatively, and preserve the old selection on failure.
- Canonical Codex account reads and switches now check response status, drop superseded reads, expose loading/error state, and avoid opaque ids in visible switch/remove feedback.
- The classic account dropdown was also changed to use the same safe label helper because its existing fallback leaked opaque ids from the same page owner.

### Declared B deviation

- Added `gui/src/styles/provider-workspace-shell.css` to the account slice. The fifth dynamic tab required horizontal overflow/focus treatment, and the touched detail rules contained undefined `--fg`/`--fg-muted` aliases. The patch maps them to existing `--text`/`--muted` tokens without changing the design system.

### Build evidence

```text
bun test --isolate tests/provider-workspace-auth.test.ts tests/rate-limit-reset-credits.test.ts
  20 pass / 0 fail / 52 assertions
bun test --isolate tests/codex-auth-api.test.ts
  50 pass / 0 fail / 139 assertions
focused ESLint (5 touched TS/TSX files)
  0 errors / 0 warnings
cd gui && bun run build
  tsc PASS; Vite build PASS; pre-existing chunk-size warning only
git diff --check
  PASS
```

## C verification receipt — 2026-07-18

### Automated

```text
focused account/OAuth/Codex/workspace suite
  126 pass / 0 fail / 422 assertions
bun run privacy:scan
  PASS
focused touched-file ESLint
  PASS (0 errors / 0 warnings)
gui production build
  PASS
gui lint:i18n
  BLOCKED by pre-existing ProviderOverview.tsx:152 react-hooks/set-state-in-effect
  (outside this slice; the same baseline blocker was recorded before B)
```

### In-app Browser against Vite -> live `:10100` API

- Anthropic rendered five linked tabs and two masked account rows with exactly one focusable `aria-current` row. ArrowRight moved Accounts -> Settings and Home moved Settings -> Overview.
- Switched the non-current Anthropic row through the workspace UI, observed its `aria-current=true` state after the authoritative refresh, restored the captured original active account through the same API contract, and verified equality without printing either id.
- Canonical OpenAI rendered the embedded main + three-account pool with masked labels and quota bars. Switched a non-current account through the confirmation dialog, observed the target card become `card-active`, restored the captured original active account, and verified equality without printing ids.
- Console contained Vite/React development messages only; zero error/warn entries.
- Visual review confirmed the account tab itself is legible and aligned. The already-planned wide-shell clipping/duplicate rail controls remain visible at this viewport and are assigned to `provider-rail-polish`; they do not invalidate account selection behavior.

### C judgment

Account selection, failure-safe state ownership, privacy, and keyboard semantics pass. The only open visual defect belongs to the next registered shell/rail work phase.

VERDICT: PASS (account-switcher)
