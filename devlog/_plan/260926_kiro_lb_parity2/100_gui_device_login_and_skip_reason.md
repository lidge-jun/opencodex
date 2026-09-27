# 100 — Dashboard native Kiro login and auto-selection chip

Work phase wp11. Branch `codex/kiro-lb2-100-gui-device-login` from dev `e69347a202`. This is the single
executable plan; later sections refine it and are folded in, never override silently.

## Why

081 records two dashboard rows where kiro-lb still leads: a browser device-login flow and an operator view of
why an account is skipped. The server side for both already landed — native device login routes (060,
`src/server/management/oauth-account-routes.ts` start ~239, status ~330-342, cancel ~304-314;
`src/oauth/kiro-device-login.ts` public `KiroDeviceView`) and per-row `autoSelectable` / `skipReason`
(070, roster ~407). This unit is **`gui/` plus docs only**; no `src/` change, so the core–Lab boundary and
the server contracts are untouched.

## Decisions

- **D100-1 Entry point.** For `item.name === "kiro"`, both the "Add account" button
  (`gui/src/components/provider-workspace/ProviderAuthPanel.tsx` ~624) **and** the logged-out "Login" button
  (~473) open a chooser: Builder ID, Google, GitHub, and "Kiro CLI". The Kiro CLI option calls the unchanged
  `onLogin(name, addAccount)` so the existing POST without `method` stays byte-identical. Decision taken by
  main: the start route never requires an existing account, so first sign-in gets the same choice. The
  add-provider modal flow (`gui/src/components/use-add-provider-oauth.ts`) is unchanged. Non-Kiro providers
  render exactly as before.
- **D100-2 Hook.** New `gui/src/components/use-kiro-device-login.ts` (modelled on
  `use-main-device-reauth.ts`). Phases `idle | starting | pending | done | expired | failed | cancelled`.
  Reads only `KiroDeviceView` fields (flowId, method, state, userCode, verificationUri,
  verificationUriComplete, expiresAt, warning/error codes); ignores anything else. Polls
  `GET /api/oauth/status?provider=kiro&flowId=<id>` every 2 s (server paces upstream via `nextPollAt` and
  `slow_down`). Stops on any non-pending state; 404 → expired; `expiresAt` passing → expired locally.
  Responses for a replaced or cancelled flowId are ignored. On `done` it calls the existing
  `onLoginSettled` roster refresh. Timers are cleared on unmount.
- **D100-3 Dialog.** New `gui/src/components/KiroDeviceLoginDialog.tsx` using `useModalDialog`
  (role=dialog, aria-modal, labelled, focus trap, ESC, focus return). Shows the user code large with
  copy feedback (`useCopyFeedback`), an "Open verification page" link to
  `verificationUriComplete ?? verificationUri` rendered **only if it parses as https** (server also enforces),
  a `role="status" aria-live="polite"` line, a duplicate warning for `duplicate_profile_arn`, a notice for
  `manual_review_required`, and a start error for 400/409. Start controls are disabled while `starting`.
  ESC / Cancel cancels the pending flow and closes.
- **D100-4 Cancel and ordering.** Cancel sends `POST /api/oauth/login/cancel {provider:"kiro", flowId}`
  directly (not `cancelOAuthLogin`, whose provider-keyed call without flowId only stops kiro-cli). The
  native start runs inside `afterOAuthCancellation(apiBase, "kiro", …)` so an in-flight kiro-cli cancel
  settles first. The chooser is disabled while `busy === "kiro"`; Add account / Login are disabled while
  the dialog is pending. The native flow never sets `busy`, so the provider-wide polling loop in
  `use-providers-oauth.ts` is unchanged. A cancel answered with `done` (commit already happened) shows
  success and refreshes.
- **D100-5 Row chip.** `OAuthAccount` (`gui/src/hooks/useProviderAccountPools.ts` ~17) gains optional
  `autoSelectable?: boolean` and `skipReason?: "needs_reauth" | "suspended" | "cooldown" | "quota_exhausted"`.
  Label logic lives in new `gui/src/kiro-account-selection.ts`. The chip renders in the row badges only
  for Kiro rows with `autoSelectable === false`; `needs_reauth` adds nothing (reauth badge exists);
  `cooldown` adds nothing when the cooldown health badge already shows; `suspended` and
  `quota_exhausted` show "Not auto-selected: …". Unknown reasons fall back to the generic label. Tray
  unchanged.
- **D100-6 i18n.** About 25 keys under a `kiroLogin.*` / `kiroSelection.*` namespace in all 10 locale
  files (de, en, fr, ja, ko, ru, tr, vi, zh-TW, zh); reuse `common.cancel` etc. where they fit. No
  hardcoded UI text (`gui/AGENTS.md`). `gui/tests/locale-parity.test.ts` and `lint:i18n` enforce parity.
- **D100-7 CSS.** `gui/src/styles.css` is 2957/2958 capped: new rules go to
  `gui/src/styles/kiro-device-login.css`, imported from the dialog/chooser module (precedent
  `styles/login-url-block.css`). `Models.tsx` untouched.

## Change map

| Path | Change |
|---|---|
| `gui/src/components/use-kiro-device-login.ts` | NEW hook (D100-2, D100-4) |
| `gui/src/components/KiroDeviceLoginDialog.tsx` | NEW dialog (D100-3) |
| `gui/src/components/KiroLoginChooser.tsx` | NEW chooser (D100-1) |
| `gui/src/kiro-account-selection.ts` | NEW chip label helper (D100-5) |
| `gui/src/styles/kiro-device-login.css` | NEW styles (D100-7) |
| `gui/src/components/provider-workspace/ProviderAuthPanel.tsx` | MODIFY: Kiro buttons open the chooser; chip in row badges |
| `gui/src/hooks/useProviderAccountPools.ts` | MODIFY: two optional fields |
| wiring (`Providers.tsx` / provider workspace props) | MODIFY only as needed to pass `apiBase` and `onLoginSettled` |
| `gui/src/i18n/*` (10 locales) | MODIFY: new keys |
| `gui/tests/kiro-device-login.test.tsx` | NEW |
| `gui/tests/kiro-account-skip-reason.test.tsx` | NEW |
| `docs-site/src/content/docs/guides/providers.md` (~204, ~417-430) | MODIFY: dashboard choices |
| `docs-site/src/content/docs/reference/cli/providers-accounts.md` (~394) | MODIFY: one dashboard sentence |
| `structure/gui-and-management-api.md` | MODIFY: new GUI modules and the flowId-scoped cancel rule |
| `devlog/_plan/260926_kiro_lb_parity2/081_head_to_head_result.md` | MODIFY after merge evidence: drop the two dashboard rows from "still leads" |

## Tests

`gui/tests/kiro-device-login.test.tsx` (happy-dom, pattern of `provider-auth-device-code-copy.test.tsx`):
start → pending shows code and https link; non-https link is not rendered as a link; done triggers the settle
refresh; 404 → expired; cancel posts the flowId; a late reply for a replaced flow is ignored; duplicate
warning shows; unknown fields are ignored; the Kiro CLI option still POSTs without `method`; a non-Kiro
provider's Add account does not open the chooser.
`gui/tests/kiro-account-skip-reason.test.tsx`: chip only for Kiro rows with `autoSelectable === false`,
suppressed for `needs_reauth`, suppressed for `cooldown` when the cooldown badge shows, shown for
`suspended` / `quota_exhausted`.
Re-run: `main-device-reauth*.test.tsx`, `add-provider-oauth-url-leak.test.tsx`,
`provider-auth-login-copy-link.test.tsx`, `locale-parity.test.ts`.

Validation: `cd gui && bun test --isolate tests && bun run lint && bun run lint:i18n && bun run build`;
root `bun run typecheck`, `bun run privacy:scan`, `bun run structure:check`,
`bun test tests/ci-workflows/file-size-ratchet.test.ts` (or the ratchet file that exists).

## Screenshot (PR requirement for `gui/`)

No live calls: isolated `OPENCODEX_HOME` proxy + scratch Bun shim in `.tmp/` that forwards everything
except the native-method login POST, the flowId status call and cancel (canned pending/done views) and
rewrites `/api/oauth/accounts?provider=kiro` so one row has `autoSelectable:false,
skipReason:"quota_exhausted"`. Vite with `OPENCODEX_PROXY_TARGET` → shim; capture chooser, dialog, chip;
upload to `pr-assets` and link by commit SHA.

## Risks

- Social and Builder ID device replies are fixture-verified only; unexpected states end in a visible failed
  state with nothing written.
- flowId is bound to the dashboard session; a reload loses the dialog and the server keeps the orphan flow
  until expiry (≤15 min). Acceptable; documented.
- Native login is add-only (060): it never replaces an existing account.

## P reflection amendments (authoritative; they replace any conflicting text above)

Verified read-only by the architect at `e69347a202`.

1. **Row type.** Add `autoSelectable?` / `skipReason?` to `OAuthAccountRow`
   (`gui/src/components/provider-workspace/types.ts` ~55), which is what `ProviderAuthPanel` renders. The
   `OAuthAccount` change is optional.
2. **Settle wiring.** Extract the completion block in `gui/src/pages/use-providers-oauth.ts` ~173-196
   (`onLoginSettled`, `fetchAccountSets`, same-account/ok notice, `fetchConfig`, `fetchProviderQuotas(true)`,
   `bumpModelsRefresh`) into `settleProviderLogin(provider, {addAccount})` with **identical** behaviour for
   the existing kiro-cli/other-provider path. Expose it as an **optional** `onNativeLoginSettled` on
   `ProviderAuthHandlers` (types.ts ~83; optional because 8 tests build `authHandlers` literally) and wire it
   in `Providers.tsx` (~644). First login needs `fetchConfig` because the server upserts `kiro` into config,
   and the panel flips to logged-in only when `accounts.length > 0`.
3. **404 is not "expired".** Status returns a terminal view once and then forgets the flow; a lost `done`
   reply becomes 404. Map 404 (status or cancel) to a neutral "login ended" state and **always run the settle
   refresh**. "Expired" only for an `expired` state or the local `expiresAt` check. No per-tick abort
   under ~45 s (upstream device calls take up to 20 s).
4. **Close during start.** Use a generation guard: if the dialog closed or restarted while `starting`,
   immediately POST cancel with the returned `flowId`. Orphans otherwise stay pending up to the device
   lifetime (≤15 min) and count toward the 4-pending-flow limit (409). The Risks line reads "≤15 min".
5. **Unmount.** On unmount stop polling and send a best-effort cancel; if the cancel answers `done`, run the
   settle refresh.
6. **ESC / dialog.** `useModalDialog` drives a native `<dialog>`; add
   `onCancel={e => { e.preventDefault(); cancelFlow(); }}` (precedent `dashboard-dialogs.tsx` ~35).
   `triggerRef` is the Add account / Login button. The chooser is step one of the same dialog.
7. **Route shapes.** Start `POST /api/oauth/login {provider:"kiro", method:"builder-id"|"google"|"github"}`
   (hyphen). Never send `accountId` or `reauth` (400 `native_login_is_add_only`). Errors `{error}`: 400
   invalid method; 409 could-not-start / flow limit / namespace collision. Status: bare `KiroDeviceView`
   (warning codes only, no error field); unknown/foreign/past-deadline → 404 `{error:"unknown login flow"}`.
   Cancel `POST /api/oauth/login/cancel {provider:"kiro", flowId}` → view (`cancelled`, `done` if
   committed, or the existing terminal state); forgotten → 404. Anchors: start 225-251, status 335-352,
   cancel 304-315.
8. **CSS.** Import `./styles/kiro-device-login.css` from the component module (precedent
   `AccountAutoSwitchControl.tsx` ~5), **not** from `styles.css`. Semantic design-system tokens only (no
   hex/rgb), reuse `.btn` / `.badge`; the chip uses `.badge-amber`.
9. **i18n.** Each locale is compile-checked `Record<TKey,string>`; `sync-locale-keys.mjs` skips `vi` (add
   by hand); `locale-parity.test.ts` fails if a zh-TW value equals English; `kiro-account-selection.ts`
   returns `TKey`s, never strings.
10. **Other Kiro entry points stay on kiro-cli** (tested): `CatalogAccountRow.tsx` ~70/88/107,
    `AddProviderModal.tsx` ~238, add-intent at `Providers.tsx` ~562. In the chooser, Kiro CLI is listed
    first (one-click import of an existing kiro-cli session stays the fastest path).
11. **Tests.** happy-dom window with manual globals, `globalThis.fetch` replaced/restored, `showModal`
    stubbed as in `action-dialogs.test.ts`; the poll interval is injectable. Add: logged-out Login →
    chooser → `done` → settle handler (config refresh); lost `done` then 404 → neutral state + settle;
    close while `starting` → cancel with returned flowId.
12. **Screenshot shim** also forwards `/opencodex-session` and `/healthz` and passes cookies unchanged.

Validation (final):
```
cd gui && bun run lint:i18n && bun run lint && bun run build && bun test --isolate tests
bun run typecheck
bun test tests/ci-workflows/file-size-ratchet.test.ts tests/ci-workflows/structure-ssot.test.ts
bun run structure:check && bun run privacy:scan
cd docs-site && bun run build
```

## A audit amendments (round 1; authoritative over everything above)

- **A1 (High) Provisional done on cancel.** `cancelKiroDeviceLogin` returns a synthetic `{state:"done"}` while
  the flow is still `pending` once `commitAccepted` is set (`src/oauth/kiro-device-login.ts` ~303); the
  write and `publishConfig` can still fail and roll back (~266-278). The hook treats a cancel reply of
  `done` as **provisional**: it keeps polling status for that flowId (the flow is not forgotten on this path)
  and shows success only on a status reply with `state:"done"`; `failed` shows failure; a later 404 goes to
  the neutral "login ended" path (A3). Only the terminal status reply triggers the success settle.
- **A2 Settle split.** Do **not** move the reauth identity checks, baseline comparison, roster seed or
  generation guard out of the existing polling loop in `use-providers-oauth.ts`; that path stays
  behaviourally identical. Extract only the shared refresh work into
  `refreshAfterProviderLogin(provider)` (`onLoginSettled`, `fetchAccountSets`, `fetchConfig`,
  `fetchProviderQuotas(true)`, `bumpModelsRefresh`); notices stay with the caller. The optional handler
  becomes `onNativeLoginSettled(provider, outcome: "added" | "ended")`: `added` refreshes and shows the
  existing added/ok notice; `ended` refreshes without a success notice.
- **A3 404.** A 404 on status or cancel → refresh the roster (`outcome:"ended"`) and show the neutral
  "login ended — check the account list" state. Never a success notice.
- **A4 Verification destination.** The GUI renders a clickable link (`target="_blank"`,
  `rel="noopener noreferrer"`) only for https URLs whose host is `kiro.dev`, `amazonaws.com`,
  `aws.amazon.com` or `awsapps.com`, or a subdomain of one of those (exact label-boundary suffix
  match, no userinfo, no port other than default). Any other URL is shown as plain copyable text with a
  "unexpected verification host" notice and no link. Pure helper `kiroVerificationLink(url)` in
  `gui/src/kiro-account-selection.ts` (renamed module is fine: `gui/src/kiro-device-login-helpers.ts`),
  unit-tested with spoofing cases (`kiro.dev.evil.com`, `evilkiro.dev`, userinfo, http, control chars).
- **A5 Race tests (controlled promises).** Add: cancel → provisional `done` → status `done` → success;
  cancel → provisional `done` → status `failed` → failure; two rapid starts (second ignored or first
  cancelled, never two pending flows shown); cancel while a status reply is in flight (late pending reply
  ignored); unmount with an unresolved start → cancel with the returned flowId; ESC cancels; focus returns to
  the trigger on close.
- **A6 Docs.** Also rewrite `docs-site/src/content/docs/guides/providers.md` ~442 so Add account
  distinguishes the native device choices (add-only, no kiro-cli sign-out) from the Kiro CLI choice.

## A audit amendments (round 2; authoritative over everything above)

- **A7 (High) Finalizer survives unmount.** The live config is reconciled only when a status request observes
  `done` (`oauth-account-routes.ts` ~340-346). The GUI therefore owns a **module-scoped finalizer**
  `finalizeKiroDeviceFlow(apiBase, flowId)` in `gui/src/kiro-device-login-finalizer.ts`: a de-duplicated
  (one per flowId) loop that GETs status every 2 s until a terminal state or 404, bounded by the flow's
  `expiresAt` plus 60 s, independent of any React component. It resolves to `"added" | "ended" | "failed"`
  and emits the result to subscribers (`subscribeKiroDeviceFinal`). The hook hands the flow to the
  finalizer whenever it stops watching a flow whose commit may be in progress: after a provisional `done`
  from cancel, and on unmount/close with an unresolved start or a pending flow (after sending the cancel).
  The Providers page subscribes and runs `onNativeLoginSettled` when mounted; if the page is gone, the
  finalizer's status read alone is enough for the server to reconcile. Residual risk: closing the whole
  browser tab during the commit window skips reconciliation until the next config reload; this is recorded
  as a server follow-up candidate in 000 and in the PR.
- **A8 In-flight terminal replies win.** The hook (and finalizer) processes a terminal reply from a status
  request already in flight even after Cancel; a later 404 still takes the neutral path (A3). A1's promise
  becomes: success is shown only after a terminal `done` status reply is observed.
- **A9 Settle split at the guard.** Two helpers: `reloadAccountsAfterLogin(provider)` (awaited
  `fetchAccountSets`) and `refreshDerivedAfterLogin()` (`fetchConfig`, `fetchProviderQuotas(true)`,
  `bumpModelsRefresh`). The existing loop keeps its generation/mounted guard **between** them, keeps its
  roster seed and notice calculation inline, and is otherwise unchanged. The native path calls
  `onLoginSettled` → `reloadAccountsAfterLogin` → mounted check → notice (added only) →
  `refreshDerivedAfterLogin`.
- **A10 Exact hosts.** `kiroVerificationLink(url)` returns a link only for https URLs, no userinfo, default
  port, whose host is exactly `device.sso.us-east-1.amazonaws.com` (Builder ID) or exactly `kiro.dev` or a
  label-boundary subdomain of `kiro.dev` (Kiro-owned; social). Everything else, including other
  `amazonaws.com` hosts and any `awsapps.com` portal (user-creatable), is shown as plain copyable text
  with the unexpected-host notice. Tests include `evil.s3.amazonaws.com`, `x.awsapps.com`,
  `kiro.dev.evil.com`, `evilkiro.dev`, userinfo, explicit port, http, control characters.

## A audit amendments (round 3; GO-WITH-FIXES folded; final)

- **A11** `onLoginSettled` (Accounts-tab reveal + models notice) runs **only** for a confirmed `added`.
  `ended` runs `reloadAccountsAfterLogin` and shows the neutral message; it never opens the models notice.
- **A12** `onNativeLoginSettled(provider, outcome: "added" | "ended" | "failed")`. `failed` reloads accounts
  and shows the existing `prov.loginError`-style failure notice through `notify(..., false)`, so a failure
  finalized after the dialog unmounted is still visible. Tested through the finalizer subscriber path.
- **A13** "Terminal replies win" holds across the hook and the finalizer: once `done` or `failed` is observed
  for a flowId, a later 404 cannot replace it. The whole-tab-close residual is recorded in `000_plan.md`
  (server follow-up table).

Audit record: round 1 NO-GO (1 High, 4 Medium, 1 Low) → round 2 NO-GO (1 High, 3 Medium) → round 3
GO-WITH-FIXES (0 High, 2 Medium, 1 Low; folded as A11-A13).
