# 001 — Current API tab surface

Inventory of what exists at `33caf3364`. No diffs here (LEXICO-SPLIT-01); the
phase documents own those.

## 1. Component and data map

Route `api` mounts `<ApiKeys apiBase={API_BASE} />` (`gui/src/App.tsx:31-47`,
`:297-320`). `ApiKeys` owns every fetch and all action state; `ApiKeysWorkspace`
owns only selection and delete confirmation.

| Concern | Owner | Evidence |
|---------|-------|----------|
| Key + endpoint fetch | `ApiKeys.fetchKeys` → `GET /api/keys` | `gui/src/pages/ApiKeys.tsx:75-94` |
| Model catalog fetch | `ApiKeys.fetchModels` → `GET /v1/models` | `:96-116` |
| Resource identity | `api-keys:${apiBase}`, `api-models:${apiBase}` | `:118-131` |
| Session cache | `ocx.apikeys.list.v1:*`, `ocx.apikeys.models.v1:*` (prefixes only, never key material) | `:61-64`, `:91-92` |
| Create / delete | `POST` / `DELETE /api/keys`, then `refreshKeys()` | `:152-198` |
| Model test | `POST endpoints.chatCompletions`, `max_tokens: 1`, no auth header | `:231-260` |
| Selection + delete arm | `selectedId`, `confirmDelete`, 300 ms arm | `ApiKeysWorkspace.tsx:79-115` |

Overview composition (`ApiKeysWorkspace.tsx:224-263`): left column is
`ApiKeysManagePanel` (create-only, `showKeyList={false}`), `ApiKeysEndpointsPanel`,
`ApiKeysUsagePanel`; right column is `ApiKeysModelsPanel`. Auth notes and curl
examples are both closed `<details>` (`api-keys-panels.tsx:191-202`, `:467-489`).

Backend chain: `/api/*` requires **management** auth and dispatches through
`handleManagementAPI` (`src/server/index.ts:391-396`) into
`handleOauthAccountRoutes` (`src/server/management-api.ts:125-136`), where the
three key routes live (`src/server/management/oauth-account-routes.ts:436-469`).
A data-plane `ocx_` key does not authorize key management.

## 2. The key entry, as actually stored and served

```ts
apiKeys?: Array<{ id: string; name: string; key: string; createdAt: string }>
```

`src/types.ts:678`. `configSchema` never declares `apiKeys`; it survives loading
only because the object is `.passthrough()` (`src/config.ts:669-704`), so no
field-level validation runs on it.

Creation (`oauth-account-routes.ts:449-459`): `id` is `crypto.randomUUID()`,
`name` is the trimmed input or `"default"`, `key` is `ocx_data_` + 40 hex from
`sha256(providerKeys | uuid | Date.now())`, `createdAt` is an ISO string.

GET serves `{ id, name, prefix, createdAt }` where `prefix = key.slice(0, 8) +
"..."` (`:444`). The full secret is returned exactly once, by POST (`:460`).

Nothing exists for scope, expiry, last-used, revocation state, rotation lineage,
usage counters, or creator. Revocation is physical deletion (`:464-469`).

## 3. Weaknesses, with the code that shows them

Ordered by whether a user is actively misled, then by whether the surface is
lying about itself, then by friction.

### Misleading

**W1 — The auth note is wrong for Chat Completions.** `api.authChatCompletions`
(`gui/src/i18n/en.ts:1266`) promises `Authorization: Bearer` works; the route uses
`requireResponsesApiAuth` (`src/server/index.ts:654`), which reads only
`x-opencodex-api-key` (`src/server/auth-cors.ts:265-274`). Following the on-screen
instruction produces a 401 with no diagnosis. The rule genuinely differs per
endpoint — `/v1/models` (`index.ts:403`) and `/v1/messages` (`index.ts:617`) use
`hasValidApiAuth`, which does accept bearer and `x-api-key`
(`auth-cors.ts:250-257`) — so one sentence cannot state it correctly.

**W2 — "Test" proves less than it appears to.** Every row advertises Responses,
Chat Completions and optionally Messages (`api-keys-panels.tsx:391-416`), but the
test always posts a chat body to `endpoints.chatCompletions`
(`ApiKeys.tsx:231-253`). An `OK` badge next to a Responses chip is unearned.

**W3 — The test never exercises key auth.** Its headers are `Content-Type` only
(`ApiKeys.tsx:235-243`). On loopback that passes because auth is bypassed
(`auth-cors.ts:184-193`), so a green test says nothing about whether a remote
client with the generated key would get in — which is the tab's entire purpose.

**W4 — Copy can report success after failing.** `copyKey` neither awaits nor
catches `navigator.clipboard.writeText` and sets `copied = true` immediately
(`ApiKeys.tsx:200-215`); `copyModelId` right below it does catch (`:216-224`).
The one string in the product that is shown exactly once is the one whose copy
failure is silent.

**W5 — DELETE always claims success.** It filters and returns `{success:true}`
without checking the length changed (`oauth-account-routes.ts:464-469`). A stale
id reads as "revoked".

### Self-misdescribing

**W6 — Every prefix is identical.** `ocx_data_` is 9 characters; the mask keeps 8
(`:444`, `:457`). Every row reads `ocx_data...` (`ApiKeysWorkspace.tsx:150`).

**W7 — The detail pane repeats the rail.** Rail: name, prefix, date
(`ApiKeysWorkspace.tsx:142-153`). Detail: name, prefix, date (`:204-219`). The
only thing detail adds is the Delete button.

**W8 — No per-key usage or last-used.** Nothing in the stored entry
(`src/types.ts:678`) or the served row (`oauth-account-routes.ts:443`) says
whether a key has ever been used. A user cannot tell an abandoned key from a
load-bearing one, which makes deletion a guess.

**W9 — Empty catalog and empty search read the same.** Any zero-length
`filteredModels` renders `api.modelsEmpty` (`ApiKeys.tsx:141-150`,
`api-keys-panels.tsx:363-379`).

**W10 — `api.workspace.selectKeyHint` is dead.** Present in all six locales
(`en.ts:1289`) and rendered nowhere; Overview occupies that state instead
(`ApiKeysWorkspace.tsx:223-264`).

### Friction and access

**W11 — No rename.** Only GET/POST/DELETE exist (`oauth-account-routes.ts:436-469`)
and detail offers only Delete (`ApiKeysWorkspace.tsx:169-220`). Fixing a typo
means issuing a new key and redeploying it.

**W12 — Delete navigates away before it succeeds.** Confirm clears selection
immediately (`ApiKeysWorkspace.tsx:110-115`) while the request is still in flight
(`ApiKeys.tsx:182-198`); a failure surfaces as a page-level banner detached from
the key it concerns.

**W13 — No retry for the model catalog.** Cold key failure gets a retry button
(`ApiKeys.tsx:282-288`); the models resource exposes no `refresh` at all
(`:126-140`). A transient catalog failure needs a page reload.

**W14 — Test results are not announced.** Results render as plain `<p>` with no
`role="status"` or `aria-live` (`api-keys-panels.tsx:418-420`).

**W15 — Name input is unbounded.** No `maxLength` (`api-keys-panels.tsx:268-276`),
no server-side length or character validation (`oauth-account-routes.ts:449-458`).

**W16 — The two most useful blocks are collapsed.** Auth rules and runnable curl
examples are both closed `<details>` (`api-keys-panels.tsx:191-202`, `:467-489`).

**W17 — Desktop locks the viewport.** At ≥1100x700 the page becomes `100dvh`
with `overflow: hidden` (`styles-apikeys-workspace.css:536-552`) and the model
scroller uses `overscroll-behavior: contain` (`:245-255`).

## 4. What the sibling tabs already decided

W17 and W7 are not open questions in this repository — both were settled in the
last week, on other tabs, against the pattern the API tab still uses.

`5aa51b9d7` ("make Usage, Storage and Subagents readable by scrolling again")
removed the fixed-height two-pane shells: "the wheel hit an inner container with
`overscroll-behavior: contain` and the page underneath never moved". The same
commit deleted the Subagents rail because "the per-model detail pane carried no
information the row did not already show" — W7, on another tab, resolved by
deletion.

`87681e540` then set the rule for long lists: cap only the genuinely unbounded
region, and use `overscroll-behavior: auto` so the gesture hands back to the page
(`styles-usage-workspace.css:149-182`, `styles-subagents-workspace.css:129-181`).
Storage kept a rail but made it single-column and page-scrolled
(`styles-storage-workspace.css:11-23`).

Storage is also the counter-example to deleting the API rail: its rows carry
comparative data (name, bytes, file count) and its detail expands to oldest/newest
and largest entries (`StorageWorkspace.tsx:92-167`). A rail earns its place when
the row is comparative and the detail is deeper. That is the bar this unit's
phase 3/4 must clear, and the reason attribution comes before the redesign.

## 5. i18n and test coverage

74 `api.*` keys, `gui/src/i18n/en.ts:1255-1328`. All six locales are at parity —
`ko.ts:835-908`, `ja.ts:1203-1276`, `zh.ts:828-901`, `de.ts:808-881`,
`ru.ts:1245-1318` — with `api.workspace.selectKeyHint` present but unused (W10).
No hardcoded-string violation was found on this surface; the remaining literals
are headers, model ids and code samples, which `gui/AGENTS.md:11-32` allows.

Existing coverage:

| Area | Test |
|------|------|
| Workspace layout, retained panels, 8 locale keys | `gui/tests/apikeys-layout.test.ts:3-103` |
| Last-good data preserved when refresh fails | `gui/tests/apikeys-refresh-preserve.test.tsx:47-224` |
| Overview/detail nav, one-time secret, guarded delete | `gui/tests/apikeys-workspace.test.tsx:121-186` |
| Shared loading contract | `gui/tests/page-loading-contract.test.tsx:25-98` |
| Endpoint derivation (host/IPv6/wildcard) | `tests/api-access-endpoints.test.ts:8-85` |
| `apiKeys` survive degraded config | `tests/config.test.ts:165-220` |
| Configured keys admit to the data plane only | `tests/server-management-auth.test.ts:133-234` |
| `/v1/models` auth + origin gate | `tests/server-auth.test.ts:468-506` |

Gaps that phase 1 must close: there is **no direct test of `/api/keys`** — not GET
masking, not POST persistence, not DELETE semantics. The only route references are
a CLI fixture (`tests/cli-headless-parity.test.ts:149-155`) and an endpoint-builder
URL. GUI tests mock the route rather than exercising it
(`apikeys-refresh-preserve.test.tsx:76-92`). Locale coverage checks 8 of 74 keys
(`apikeys-layout.test.ts:90-102`).

## 6. Unverified

- The wheel-trapping consequence of W17 is a static CSS reading; it was not
  driven in a browser. Phase 5's C gate must observe it.
- Whether upstream error bodies surfaced by the model test
  (`ApiKeys.tsx:245-250`, 160 chars of `res.text()`) can carry provider-side
  detail was not traced through the adapters.
- User configs may carry extra `apiKeys` properties via passthrough; no code in
  the serving path reads them.
