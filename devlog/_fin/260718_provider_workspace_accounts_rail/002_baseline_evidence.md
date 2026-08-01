# Baseline evidence — 2026-07-18

## User-visible failures

- User screenshot `.../Screenshot 2026-07-18 at 10.15.17 AM.png`: status text and trail controls stack vertically in a narrow rail crop.
- User screenshot `.../Screenshot 2026-07-18 at 10.25.49 AM.png`: rail header/add/search controls compete for width and the split boundary dominates the composition.
- Current source render at `http://127.0.0.1:10100/#providers/workspace`: desktop source is improved over the earlier screenshots, but the rail still repeats the page title/action and represents name, badge, model count, star, status, and chevron as six horizontal flex fragments.
- Kimi detail baseline: Overview / Models / Usage / Settings only; Authentication says Not logged in even though the local OAuth account endpoint reports one active Kimi account. Root cause is omitted workspace props, not missing backend data.

## Live local account inventory

Read-only count probes intentionally omitted IDs and emails:

```text
anthropic        count=2 active=1 reauth=0
xai              count=1 active=1 reauth=0
kimi             count=1 active=1 reauth=0
cursor           count=1 active=1 reauth=0
google-antigravity count=1 active=1 reauth=0
openai-codex     count=4 main=1 reauth=0
openai-active    present=true autoSwitchThreshold=0
```

This supplies real many-account activation cases for generic OAuth and canonical Codex without fabricating fixture-only UI.

## Contract evidence

- Generic list: `GET /api/oauth/accounts?provider=P` -> `{ activeAccountId, accounts[] }` with masked summaries (`src/server/management-api.ts:1271-1277`, `src/oauth/index.ts:519-538`).
- Generic switch: `PUT /api/oauth/accounts/active` -> validated account selection plus quota-cache clear (`src/server/management-api.ts:1279-1288`).
- Persistence: `setActiveAccount` writes the provider account set under the existing store lock (`src/oauth/store.ts:286-293`).
- Codex list/active: `GET /api/codex-auth/accounts`, `GET/PUT /api/codex-auth/active` (`gui/src/components/CodexAccountPool.tsx:44-82`, `src/codex/auth-api.ts:445-468`).
- Existing-thread caveat: Codex active selection applies to new routing while thread affinity may keep an existing thread on its earlier account (`src/codex/routing.ts:341+`).

## Baseline defects and activation scenarios

1. Workspace wiring: `Providers.tsx:464-480` supplies only `oauthEmail`; `ProviderDetails` already accepts the omitted account props (`ProviderDetails.tsx:24-68`).
2. Generic load state: `{}` represents not-loaded, failed, and loaded-empty; activation is a failed/delayed account GET.
3. Generic stale response: account fetches replace the full map and have no generation owner; activation is old GET -> switch -> new GET -> old GET resolution.
4. Generic network failure: `switchAccount` lacks a `try/catch`; activation is rejected fetch.
5. Reauth: generic rows remain switchable; activation is `needsReauth: true` on a non-active row.
6. Codex false success: `setActive` ignores `res.ok` and mutates local state; activation is a 400/500 active PUT.
7. Codex overlap: 30-second polling and user refresh have no generation ordering; activation is overlapping loads resolved out of order.
8. Auth surface ownership: every `authMode=forward` embeds Codex pool; activation is a custom forward provider that is not canonical OpenAI.
9. Tab semantics: current tabs omit controls/panels/arrow navigation; activation is keyboard-only navigation.
10. Rail semantics: current listbox container and every option are Tab stops; activation is keyboard traversal through the rail.
11. CSS drift: provider workspace uses undefined `--fg` and `--fg-muted`; activation is active filter/tab state in either theme.

## Existing focused evidence

- Independent account-contract explorer: 118 relevant API/store/workspace tests passed, zero failed.
- Independent design-system explorer: 57 catalog/state/payload tests passed, zero failed.
- Existing lint blocker unrelated to this unit: `ProviderOverview.tsx` reports `react-hooks/set-state-in-effect`; implementation must not hide it, and completion distinguishes baseline lint debt from introduced failures.

## Browser baseline observations

- Default desktop: current rail is readable but horizontally over-specified; workspace detail has no account tab.
- 1024 requested viewport: the source still renders the full three-column app/rail/detail composition; detail content is visibly compressed and page actions approach the viewport edge.
- 768 requested viewport in the in-app capability reported an effective 960px CSS client width, so final evidence must record both requested and effective widths and include an additional width that actually crosses the 760px CSS boundary.
- No destructive account mutation occurred during baseline capture.
