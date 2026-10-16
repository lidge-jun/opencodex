# 010 — Phase 1: credits parse, store, DTO, setting, GUI row

Consumes 000 decisions D1–D4. Two disjoint write scopes so two workers can run in parallel.

## 010.S Server scope (worker S)

NEW `src/codex/credits.ts`
```ts
export interface CodexCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  overageLimitReached?: boolean;
  /** Decimal string exactly as upstream sent it after validation, e.g. "62498.725". */
  balance?: string;
  approxLocalMessages?: [number, number];
  approxCloudMessages?: [number, number];
}
/** undefined = field absent (keep previous); null = explicit null or unusable (clear). */
export function parseCodexCredits(raw: unknown): CodexCredits | null | undefined;
export function rememberCodexCredits(accountId: string, identity: string, parsed: CodexCredits | null | undefined): void;
export function codexCreditsFor(accountId: string, identity: string | null): CodexCredits | undefined;
export function pruneCodexCredits(liveAccountIds: Iterable<string>): void;
export function resetCodexCreditsForTests(): void;
```
Rules: balance accepted when a string matching `/^\d+(\.\d+)?$/` or a finite
non-negative number (stringified); otherwise the field is dropped. Approx ranges must be
two finite non-negative numbers. An object with no usable field parses to `null`.
Identity mismatch in `codexCreditsFor` deletes the entry and returns undefined.

MODIFY `src/codex/quota.ts`: `WhamUsageResponse` gains `credits?: unknown` (typing only).

MODIFY `src/codex/auth-api/main-account-probe.ts`: next to
`rememberMainResetCredits(requestAccountId, freshResetCredits)` (credential-current branch
only) add
`if (requestAccountId !== null) rememberCodexCredits(MAIN_CODEX_ACCOUNT_ID, requestAccountId, parseCodexCredits(data.credits));`

MODIFY `src/codex/auth-api/pool-quota-probe.ts`: in the WHAM publish function, after the
`mayPublish` guard and only when `isCodexAccountGenerationLive(accountId, generation)`,
`rememberCodexCredits(accountId, accountId, parseCodexCredits(data.credits));` — this must
run whether or not `parseUsageQuota` produced a quota.

MODIFY `src/codex/auth-api/account-list.ts`:
- `CodexAuthAccountDto` gains `credits?: CodexCredits`.
- helper `codexCreditsDtoField(config, accountId, identity)` (in credits.ts or here) returns
  `{ credits }` only when `config.showCodexCredits === true` and a value exists.
- `poolAccountDto`: spread `codexCreditsDtoField(config, account.id, account.id)`.
- main DTO: spread `codexCreditsDtoField(runtimeConfig, MAIN_CODEX_ACCOUNT_ID, getMainChatgptAccountId())`.
- `listCodexAuthAccountsSnapshot`: `pruneCodexCredits([MAIN_CODEX_ACCOUNT_ID, ...pool ids])`.

Setting chain (mirror `oauthOpenBrowser` / retired `showCodexSparkQuota`):
- `src/types/config.ts`: `showCodexCredits?: boolean` with a doc comment (display only, default off).
- `src/config/schema/config-schema.ts`: `showCodexCredits: z.boolean().optional().catch(false)`.
- `src/config/diagnostics.ts` / `src/config/load-degrade.ts`: add the same malformed-value
  diagnostic/degrade treatment the neighbouring booleans have, if that chain is exhaustive.
- `src/server/management/config-routes.ts`: GET `/api/settings` returns
  `showCodexCredits: config.showCodexCredits === true`; PUT accepts a boolean, adds it to the
  "provide ..." list and type check, mutates, persists and restores prior value/presence on
  save failure. Check `src/server/auth-cors.ts` ~1260 for a second settings projection.

Tests (new files, registered in both layout manifests, domain `codex-integration`):
- `tests/codex-integration/codex-credits.test.ts`: parser (integer string, fractional
  string, numeric, zero, negative/garbage, absent, null, empty object, approx ranges),
  store identity binding (mismatch clears), null clears, absent keeps, prune, DTO field
  on/off.
- `tests/codex-integration/codex-credits-settings.test.ts`: GET default false, PUT true
  persists and GET reflects it, PUT non-boolean → 400, save failure rolls back.

## 010.G GUI scope (worker G)

- MODIFY `gui/src/hooks/useCodexAccountPool.ts`: `CodexAccountEntry.credits?: CodexCredits`
  (GUI copy of the type).
- NEW `gui/src/components/CodexCreditsRow.tsx`: renders
  `<div className="codex-account-quota-slot quota-compact codex-credits-slot">` containing one
  `.quota-row.quota-row--codex-credits` with: label `t("codexAuth.credits")`, reset-label
  column `t("codexAuth.creditsRemaining")`, empty day/time columns, a `.bar` whose fill is
  100% (`ok` tone) for positive balance or unlimited and 0% otherwise, and a value span
  with the formatted balance (`Intl.NumberFormat(locale, { maximumFractionDigits: 2 })`),
  `t("codexAuth.creditsUnlimited")`, or balance + ` · ` + `t("codexAuth.creditsOverage")`.
  `title` = approx ranges via `t("codexAuth.creditsApprox", {...})` when present. Returns
  null when `credits` is undefined or has neither balance nor unlimited.
- NEW `gui/src/styles/codex-credits.css` (imported by the component): pull the slot up
  under the quota slot (no double padding) and keep the value column nowrap.
- MODIFY `gui/src/components/codex-account-pool-main-card.tsx` and
  `gui/src/components/codex-account-pool-cards.tsx`: render
  `<CodexCreditsRow credits={account.credits} t={t} locale={locale} />` right after the
  non-pending `<QuotaBars .../>`.
- NEW `gui/src/hooks/useCodexCreditsVisibility.ts`: GET `/api/settings` with
  AbortController (undefined until loaded), `toggle()` optimistic PUT
  `{ showCodexCredits }`, reconcile with server answer, revert on failure, then reload
  accounts (callback). Feedback via existing `showActionFeedback`.
- MODIFY `CodexAccountPool.tsx` + `CodexAccountPoolPageHead`: pass
  `creditsVisible/creditsBusy/onToggleCredits`; render the labelled `toggle` switch
  exactly like the Spark one (class `codex-auth-credits-toggle`, styles in the new css).
- i18n (all ten locales): `codexAuth.credits`, `codexAuth.creditsRemaining`,
  `codexAuth.creditsUnlimited`, `codexAuth.creditsOverage`, `codexAuth.creditsApprox`,
  `codexAuth.creditsToggle`, `codexAuth.creditsToggleHint`, `codexAuth.creditsShown`,
  `codexAuth.creditsHidden`, `codexAuth.creditsToggleFailed`.
- Tests: `gui/tests/codex-credits-row.test.tsx` (render positive/fractional/zero/unlimited/
  overage/undefined; no "%"), plus a toggle hook/page-head test if the gui test harness
  supports it.

## Accept criteria (activation scenarios)

1. Main + pool WHAM responses carrying `credits` populate the store (unit tests call the
   publish functions or the store directly with fixture payloads).
2. `showCodexCredits` absent → `/api/codex-auth/accounts` rows carry no `credits`;
   true → rows carry `credits.balance` as a string.
3. Toggle PUT persists to config and survives reload; bad body → 400; save failure → prior
   value restored.
4. GUI: switch on → row under Week with "62,500" style value; off → no row.
5. Gates: `bun run typecheck`, focused tests, `bun run test:changed`,
   `bun run structure:check`, `bun run privacy:scan`, `cd gui && bun test` focused,
   `bun run lint:gui`, `bun run build:gui`, file-size ratchet test.


## 010.R Architect reflection fold (supersedes the matching lines above)

Architect verdict on the first revision: MISALIGNED with seven gaps; main dispositions:

1. ACCEPT — `WhamUsageResponse` lives in `src/codex/quota-types.ts:108` (`quota.ts` re-exports).
   Add `credits?: unknown` there, not in `quota.ts`.
2. ACCEPT — pool identity is the credential's `quotaHistoryIdentity`, which rotates when a
   record's `chatgptAccountId` changes (`src/codex/account-store.ts:409,470`). Write with
   `ctx.poolWriter?.historyIdentity` (skip the write when no writer was captured); read with
   `poolQuotaHistoryIdentity(account.id)` (`account-store.ts:343`). Main stays bound to the
   physical ChatGPT account id (`requestAccountId` on write, `getMainChatgptAccountId()` on read).
3. ACCEPT — pool insertion point: `commitPoolQuotaResponse` in
   `src/codex/auth-api/pool-quota-probe.ts`, immediately after the `mayPublish` early return
   and BEFORE the `if (!quota)` return, guarded by
   `isCodexAccountGenerationLive(accountId, generation)`, so credits-only payloads publish.
4. ACCEPT — "directly under Week": add an optional `afterWeekly?: ReactNode` prop to
   `QuotaBars` (compact layout only). It renders right after the row whose
   `windowKey === "weekly"`; when there is no weekly row it renders after the last row; when
   there are no rows it renders alone inside the same slot. `CodexCreditsRow` therefore renders
   only a bare `.quota-row.quota-row--codex-credits` (no own slot), and the two cards pass
   `afterWeekly={<CodexCreditsRow .../>}` instead of appending a sibling.
5. ACCEPT — state precedence: overage first (empty bar, value = balance when present then
   "· Overage limit reached", or the overage text alone), then unlimited (full bar,
   "Unlimited"), then balance (full when > 0, empty at 0). An overage-only or unlimited-only
   observation still renders; only "nothing usable" returns null.
6. ACCEPT — settings chain is not conditional: add `showCodexCreditsError` next to
   `oauthOpenBrowserError` and register it in the `boundaryError` chain at
   `src/config/diagnostics.ts:647`; schema entry `z.boolean().optional().catch(false)` in
   `config-schema.ts`. `oauthOpenBrowser` has no `warnDegraded*` helper, so none is added.
   `/api/config` `safeConfigDTO` (`src/server/auth-cors.ts:1260`) also projects
   `showCodexCredits: config.showCodexCredits === true` for parity with its neighbours.
7. ACCEPT — tests must exercise wiring, not only the store: main probe publish with a
   credits fixture (current credential → stored; stale credential → not stored), pool
   `commitPoolQuotaResponse` with credits-only payload, dead generation (not stored),
   identity rotation (read returns undefined), and omission (previous kept). SoT sync is
   mandatory: update `structure/providers/openai-accounts.md` (credits projection + identity
   binding) and `structure/config.md` (new setting); review GUI ownership doc for the
   Codex Set cards; regenerate `structure/INDEX.md` only if `manifest.json` changes.


## 010.A Independent audit fold (reviewer 01a0f17d, VERDICT NEAR-PASS)

1. ACCEPT — the cards gate on the switch as well as the DTO: `CodexAccountPool` passes
   `creditsVisible` to the main card and pool cards, and they pass `afterWeekly` only when
   `creditsVisible === true && account.credits`. A successful disable followed by a failed
   account reload must hide the row (GUI test).
2. ACCEPT — `afterWeekly` integration tests in `gui/tests/codex-credits-row.test.tsx`: order
   Week → Credits → Monthly/custom; no-week fallback; credits with `quota: null` still renders
   (the cards stop passing `pending` when there are credits to show and the account is not
   loading); stacked layout unchanged (prop ignored).
3. ACCEPT — validation adds `cd gui && bun run lint:i18n`, `cd gui && bun test tests`, and root
   `bun run test` (or the AGENTS.md resource exception, recorded with exact commands). Public
   docs: the Codex Set / multi-account guide in `docs-site/` (English + existing translated
   pages that describe the Codex Auth page head) gets one paragraph on the credits switch;
   `structure/gui-and-management-api.md` reviewed for the `/api/settings` key list.
4. ACCEPT — before merge, dispatch an explicit security review of the final diff (credential-
   bound publication, `safeConfigDTO`, no logging) and record it in the PR Verification.
5. ACCEPT — successful PUT `/api/settings` response (`config-routes.ts` ~724) includes
   `showCodexCredits`.

