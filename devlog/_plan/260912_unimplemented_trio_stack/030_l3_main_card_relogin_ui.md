# L3: main-card Re-login with device code (#3898 GUI)

Class C3 (auth-adjacent GUI). Stack layer 3, base the L2 branch. Branch
`codex/260912-native-main-reauth-ui`. Adopts
devlog/_plan/260912_accounts/090_reauth_ui.md, revalidated against current
`dev` by the GUI code map. Depends on L2's
`/api/codex-auth/main/reauth-device` contract.

## Problem

The main card is a locked App-login identity: expired state shows only
`codexAuth.mainTokenExpired` ("sign in again via Codex App login",
gui/src/components/codex-account-pool-main-card.tsx:183-185) and no
Re-login control (props at 21-56 have no `onReauth`). Pool rows have the
full device-code modal; the main card has nothing.

## Constraints (090 + code map)

- MUST NOT reuse `AddCodexAccountModal` / `openReauth("__main__")` /
  `reauthAccountId=__main__`: the pool login route rejects `__main__`
  (src/codex/account-id.ts:15-20; src/codex/auth-api.ts:221-224,2736-2748)
  and a successful pool login writes `isMain: false` rows
  (src/codex/auth-api.ts:2934-2939) — wrong credential store.
- DTO field chain: backend DTO → hook-validated state → main card only;
  no device code in browser storage; verification URL accepted only from
  the backend contract, never from arbitrary payloads.
- New copy lands in ALL locale files (en, de, fr, ja, ko, ru, tr, zh,
  zh-TW) per gui/AGENTS.md "Text and i18n".
- `tests/gui/provider-workspace-auth.test.ts:248` currently requires
  `codexAuth.mainTokenExpired` on the main card; updating that copy is
  part of this layer.

## Changes

NEW `gui/src/components/use-main-device-reauth.ts`
- Dedicated hook mirroring the pool OAuth hook's start/poll/cancel shape
  (gui/src/components/use-add-codex-account-oauth.ts:27) against
  `/api/codex-auth/main/reauth-device`: `start()` POST, `poll(flowId)`
  with visibility polling (2s tick, 10s per-tick timeout, stop on terminal
  status), `cancel(flowId)` DELETE, unmount/abort cleanup.
- Normalizes closed status/error payloads; ignores late responses from a
  replaced flow (flowId ownership); never accepts token/account-id fields;
  renders only verificationUrl + deviceCode + status.

MODIFY `gui/src/components/codex-account-pool-main-card.tsx`
- New optional `onReauthDevice` prop. When `showReauth` (83) is true,
  render a "Re-login with device code" CTA beside the existing copy; after
  start, show verification URL + human code + pending status + cancel;
  success triggers the existing parent refresh.
- Layout stays consistent with the current card; pool Add/Re-login and the
  native profile picker are untouched.

MODIFY `gui/src/components/CodexAccountPool.tsx`
- Own main-reauth modal state separate from `showAdd`/`reauthId`
  (75,94; openReauth at 189-192); wire `onReauthDevice` at the main-card render (515-533);
  pause pool refresh while the main flow is active, same as the existing
  modal pause (174-178).

MODIFY `gui/src/i18n/{en,de,fr,ja,ko,ru,tr,zh,zh-TW}.ts`
- New `codexAuth.*` keys: CTA label, pending status, cancel, terminal
  failure copy (actionable, safe; no auto-retry wording). Revise
  `mainTokenExpired` so it no longer claims App login is the only path.

## Audit folds (wp4 A)

- Start POSTs an EMPTY body (the route rejects any body with 400); poll
  immediately until verificationUrl/deviceCode arrive (they are empty in the
  start response), and keep the last url/code through the committing state.
- Map the full MainDeviceReauthStatus union + HTTP error shapes: committing
  (no url/code), failed.code (identity_mismatch, credential_changed,
  native_main_unavailable, device_authorization_failed,
  publication_failed, reconciliation_failed), 409 flow_in_progress, 503
  native_main_unavailable; when credentialUpdated is true the copy never
  claims the file was unchanged; the verification URL is allowlisted to
  https://auth.openai.com/codex/device.
- structure claim lands in structure/gui-and-management-api.md (the
  Codex-accounts row :312), not overview.md.

## Tests (red-first)

NEW `gui/tests/main-device-reauth.test.tsx` — happy-dom mount per
gui/tests convention: CTA starts the dedicated route (never
`/api/codex-auth/login`), code/URL display, cancel ownership, stale-poll
ignore, success refresh, keyboard and error states.
MODIFY `tests/gui/provider-workspace-auth.test.ts` — main-card contract
updated for the new CTA + copy.
MODIFY `tests/gui/codex-auth-modal-status.test.ts` if locale-key
assertions enumerate codexAuth keys.
The happy-dom file lives under `gui/tests/`, outside the `tests/` layout
map — layout.json explicit + expected-fixture entries are needed only for
any NEW `tests/gui/*` source-contract file, not for `gui/tests/*`.

## Docs / ownership

L3 touches owned `gui/`: sync structure/overview.md and
structure/gui-and-management-api.md in this PR (structure:check must stay
green).

## Verification

`cd gui && bun test tests/main-device-reauth.test.tsx` plus the touched
suites; `bun run lint:i18n` for copy. Local GUI build NOT RUN; PR
screenshot evidence comes from hosted CI built artifacts, or an explicit
recorded exemption (repo gate: gui-mentioning PRs need a screenshot).
