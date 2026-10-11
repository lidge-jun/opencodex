# #5561 — Anthropic OAuth model routes (diff-level plan)

Base: `origin/dev` `eb7f0f0970` (2026-09-28). Scope: backend, management API,
CLI and docs; no PR exists for this issue. This is a plan, not test or release evidence.

## Decision and source credit

**REIMPLEMENT.** [Issue #5561](https://github.com/lidge-jun/opencodex/issues/5561)
is the public source; there is no source PR, head SHA, contributor commit, or
`Co-authored-by` trailer to carry. #5752 is related usage attribution, not an
implementation of these routes. Do not invent an email from the issue author's
handle. The maintainer's [comment](https://github.com/lidge-jun/opencodex/issues/5561#issuecomment-5858443864)
requires model plumbing, exact-match/unsupported-model semantics, and affinity
and 429 regressions. Current code drops `route.modelId` at
`src/server/responses/request-transport.ts:549`, while the generic selector gets
it at `:575`; the Anthropic resolver and quota picker have no model parameter
(`src/oauth/anthropic-routing.ts:391,566`). Cherry-picking another pool's code
would change the wrong selector.

## Current dev state and contract

- Anthropic's opt-in initial path selects a credential before dispatch
  (`src/server/responses/request-transport.ts:548-566`); the disabled path still
  has presence-driven reactive 429 failover (`:668-675`,
  `src/oauth/anthropic-routing.ts:703-745`). Active/manual preference, affinity,
  no-key active retention, quota, round-robin and fill-first are separate early
  returns (`src/oauth/anthropic-routing.ts:585-674`). Successful admission binds
  affinity and advances the round-robin ring (`:780-800`). Three retry sites call
  the same rotation helper (`src/server/responses/adapter-dispatch.ts:955`,
  `adapter-continuation.ts:394`, `sidecar-execution.ts:271`).
- The legacy `GET|PUT|PATCH /api/oauth/accounts/pool` writer rebuilds the
  Anthropic settings object (`src/server/management/oauth-account-routes.ts:645-654,724-783`).
  The newer `/api/pool/settings` writer spreads existing settings (`:539-626`),
  and its DTO has a fixed supported-field list
  (`src/oauth/pool-settings-capability.ts:50-83,129-175`). The existing
  `ocx account strategy/sticky` verbs use the unified route
  (`src/cli/account-extended.ts:929-949`). Generic OAuth's model parameter is
  used for Kiro model/quota preference (`src/oauth/generic-account-failover.ts:609-633`),
  not Anthropic entitlement authority.
- Add `anthropicAccountPool.routes?: Array<{name,match,accounts,fallback?}>`.
  Rules apply only when `enabled: true`; if a stored route exists and the pool
  is turned off, document that routes are inactive and the historical active
  and presence-driven 429 behavior resumes. Match the final resolved Anthropic
  `route.modelId`, full string, case-sensitive, with bounded `*`/`?` globs;
  first matching route wins. An exact pattern means that exact model ID. No
  matching rule preserves today's selector and retry behavior. The rules are
  operator-declared allowlists, not discovered entitlement claims; an upstream
  model refusal does not prove another account has access.
- A matched route intersects **every** pick with its account IDs and the
  existing credential/reauth/cooldown eligibility. Its account order is stable;
  quota score and strategy order only within that set. An affined or manually
  selected account outside it loses priority; do not bind an excluded account.
  A round-robin commit must use the same filtered candidate set as its peek
  (`src/oauth/anthropic-routing.ts:545-556,790-797`). `fallback` is optional and
  defaults to false. With false, no eligible route account returns a local
  `authentication_error` 401 naming the route; if all configured route accounts
  are cooling, return 429 with route-scoped `Retry-After` when known. No upstream
  send occurs. With explicit `fallback: true`, an empty route set may use the
  ordinary whole-pool selector; it must never widen while an eligible routed
  account remains. For a routed 429, retain the original 429 when no replacement
  is eligible inside the route; only explicit fallback may widen. Existing
  per-request rotation and send budgets still apply.
- `route:<name>` is logged alongside the existing selection reason only after
  a committed choice, and on a routed 429 recovery. Bound/validate the route
  name and log neither credential nor raw account ID. Keep the route name in
  selection metadata separately from the existing reason union; do not reuse
  Codex's `affinityReason` log field (`src/server/request-log.ts:240`). Persist
  **rules**, not session affinity (which remains process-local, per
  `docs-site/src/content/docs/guides/claude-code.md:49-56`).

## Review blockers and resolution

1. Issue/survey: a selected account can lack the requested model and the
   existing resolver cannot know (`request-transport.ts:549`,
   `anthropic-routing.ts:566`). Pass model into the Anthropic resolver and each
   retry site; test exact/first glob match, unmatched, and unsupported/missing
   eligible route. No #5561 PR exists, so there are no #5561 PR reviews to clear.
2. Writer/reader drift: the legacy writer's whole-object assignment drops an
   added field (`oauth-account-routes.ts:765-771`); the unified DTO cannot report
   it (`pool-settings-capability.ts:50-83`). Carry rules through both writers,
   their GET/PUT/PATCH responses, and a restart round-trip; preserve them on an
   unrelated strategy/sticky update. `null` clears routes, `[]` leaves no match,
   omission preserves routes. Other pool kinds reject a supplied `routes` field.
3. Existing early returns and retry arms could bypass a matched route
   (`anthropic-routing.ts:585-674,743-745`; retry sites above). Compute one
   route decision per request and pass the filtered candidate set to all picks,
   manual/affinity checks, and recovery. On a selection-revision change,
   re-evaluate the candidate against that same route before dispatch
   (`request-transport.ts:184-190`). Keep the route decision attached to the
   request through continuation and sidecars.
4. Related #5099 has a current-head maintainer changes-requested review about
   its all-flagged fallback and missing exact-head CI (review on
   `9473f496b19a335dee56cfa5d638ff446ced6d63`); the owner says its
   bounded pre-output 401 slice already landed through #6132, while 403
   rotation and persistent health remain open. It is **not** a basis for
   importing generic health rules into Anthropic; keep that PR's blocker in
   its lane. #5956's changed-requested review concerns notification, observer
   ownership, synchronous persistence and missing regressions, not Anthropic
   routes. #6154 has no non-bot review. #5831's author review comments report
   fixes, but owner comments still withhold approval pending the two-window
   WHAM completeness contract and executable exact-head CI; no Anthropic
   change should claim to resolve that evidence gap.

## File change map

| File | Intended diff |
| --- | --- |
| `src/types/config.ts` | Canonical route type/field in `OcxConfig.anthropicAccountPool`; account handles are stored IDs, not aliases or email guesses (`:1190-1200`). |
| `src/oauth/anthropic-model-routes.ts` (new) | Bounded route parser, first-match glob evaluation, candidate intersection and named decision. No credential reads or persistence. Reject duplicate names, empty/duplicate IDs and patterns, invalid globs, unknown keys, excessive list/string size. Keep removed IDs valid in saved rules so absence yields a clear runtime error and re-add can restore them. |
| `src/config/schema/config-schema.ts`, `src/config/diagnostics.ts` | Admit the field without letting malformed hand edits silently erase it; use the shared route parser in `validateConfigCandidate` to reject writes (`diagnostics.ts:610-648`). Load preserves malformed raw routes, and the Anthropic selection boundary returns a clear local configuration error before dispatch until corrected. This avoids whole-config backup/defaults for one optional malformed field (`config-schema.ts:309` passthrough). No `src/config.ts` edit. |
| `src/oauth/anthropic-routing.ts` | Replace duplicated pool-config shape with the canonical type; pass `modelId`/decision to initial, strategy, affinity and reactive picks; preserve cooldown and commit semantics (`:391-461,566-674,703-800`). Make route-scoped retry deadline available (`:357-369`). |
| `src/server/responses/request-transport.ts` | Resolve the route from `route.modelId`; enforce local route-empty/config-invalid errors before credential admission; keep decision for retries, verify any conflict-reselected account belongs to it, and emit route+reason only after commit (`:150-193,548-566`). |
| `src/server/responses/adapter-dispatch.ts`, `adapter-continuation.ts`, `sidecar-execution.ts` | Thread request route decision to the three `rotateAnthropicAccountOn429` calls; no replay when the route has no alternate. Retain existing non-replayable and request-budget guards. |
| `src/server/management/oauth-account-routes.ts`, `src/oauth/pool-settings-capability.ts` | Validate/replace/preserve/clear routes in both settings endpoints; expose them in Anthropic GET/echo and unified `supported`, with `null` for other kinds. Save via the existing config writer (`oauth-account-routes.ts:623-626,765-783`). Keep route validation independent of account-roster membership. |
| `src/cli/account-extended.ts`, `src/cli/account.ts`, `src/cli/capabilities.ts` | Add `ocx account routes anthropic [--file <json-file>|--clear] [--json]`: bare read via unified GET; file write via unified PATCH; clear via `routes:null`. The CLI reads a bounded local file and lets the server own semantic validation. Register the verb and help. `ocx config set anthropicAccountPool.routes '<json>'` remains a lower-level validated option (`config-command.ts:234-268`). |
| `skills/ocx/references/01_management_surface.md` | Regenerate with `bun run skill:surface` after the capabilities addition; check with `bun run skill:surface:check`. |
| `tests/adapters/anthropic/anthropic-model-routes.test.ts` (new) | Focused selector, affinity, strategy and 429 regressions below; register in both test-layout manifests. |
| `tests/server/account-pool-management-api.test.ts`, `tests/cli/cli-account-pool-verbs.test.ts`, `tests/config/config-save-boundary.test.ts` | API/read/write/restart, CLI dispatch, and config validation/survival cases. Preserve the unified DTO fixed-key golden (`account-pool-management-api.test.ts:776-797`). |
| `structure/config.md`, `structure/providers-and-adapters.md`, `structure/transports/responses-failover.md`, `structure/gui-and-management-api.md` | Record config/selection, retry, and API contracts; review `structure/runtime.md` and `structure/transports/inventory.md` under the `structure/INDEX.md` source map, editing only sentences whose meaning changes. |
| `docs-site/src/content/docs/reference/configuration/providers.md`, `guides/claude-code.md`, `reference/management-api.md`, `reference/cli/providers-accounts.md` | Add the route schema, matching/empty/fallback behavior, API and CLI examples; update translated `reference/configuration/providers.md` in fr/ja/ko/ru/tr/zh-cn/zh-tw and translated `guides/claude-code.md` where present (fr/tr/zh-tw), so existing "eligible account" and 429 descriptions do not contradict the new route boundary. |

No GUI change is required: `gui/src/pool-settings.ts:59-81` sends only edited
fields, and both server writers retain rules on unrelated updates. Confirm with
the API regression. `src/config.ts` and `src/server/index.ts` are out; new
provider entitlement discovery, 403/401 automatic replay, quota probes and
mid-stream resume are out. The only new config field is `routes`; the chain is
type → parser/validation → both management writers and config persistence →
request selector/retry consumers → structure/public docs. GUI N/A because no
route editor is proposed. No migration: absent routes preserve old behavior.

## Size and layout

`tests/fixtures/file-size-baseline.json` tracks **none** of the proposed
modified source/test files. The only nearby tracked file is `src/config.ts`
(385 lines against cap 460); this plan does not change it. Keep route parsing
in the new sibling module instead of growing the 898-line
`src/oauth/anthropic-routing.ts`. Add
`anthropic-model-routes.test.ts` to both `scripts/test-layout/layout.json`
`explicit` and `tests/fixtures/test-layout-expected.json`; the existing
`tests/test-layout.test.ts` and `tests/test-layout-tooling.test.ts` verify the
mapping. Recompute counts against the actual PR base after other lane merges.

## Proof to require in implementation PR

- `tests/adapters/anthropic/anthropic-model-routes.test.ts`: enabled pool with
  lower-usage out-of-route account selects in-route; first match wins; exact
  model matches exact pattern; unmatched model preserves old selection; invalid
  pattern/config refuses before send; no eligible matched route returns named
  401, all-cooled returns named 429 and scoped `Retry-After`; explicit fallback
  widens only on empty route. Assert serving account/request count, status/body
  and safe route log reason, not just helper return values.
- Same file: same session/model retains in-route affinity; model switch drops
  out-of-route affinity; manual/active choice outside route is excluded; quota,
  round-robin/sticky and fill-first never escape the route; 429 rotates to a
  sibling in-route, never to a lower-usage outsider, across normal, continuation
  and sidecar pre-output paths. Assert one per-request rotation budget, no
  post-output replay, and route-scoped no-alternate behavior with a mock upstream.
  Disabled/no-routes controls preserve historical 429 activation.
- `tests/server/account-pool-management-api.test.ts`: both settings routes
  validate, GET/PUT/PATCH/clear/echo, unsupported-kind 400, strategy-only update
  retains rules, persisted reload/restart returns identical rules; GUI-style
  partial save retains them. `tests/config/config-save-boundary.test.ts`:
  malformed direct config write rejects, malformed disk route remains visible
  as a diagnostic without losing unrelated providers, and runtime refuses it.
  `tests/cli/cli-account-pool-verbs.test.ts`: read/write/clear and malformed-file
  nonzero exit. Check `tests/cli/cli-headless-parity.test.ts` and
  `tests/ci-workflows/skill-ocx.test.ts` because CLI capability generation is
  derived rather than import-connected.
- Commands: `bun run typecheck`; `bun test tests/adapters/anthropic/anthropic-model-routes.test.ts tests/adapters/anthropic/anthropic-account-pool.test.ts tests/server/account-pool-management-api.test.ts tests/cli/cli-account-pool-verbs.test.ts tests/config/config-save-boundary.test.ts tests/cli/cli-headless-parity.test.ts tests/ci-workflows/skill-ocx.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts`; `bun run test:changed`; `bun run structure:check`; `bun run privacy:scan`; `bun run skill:surface:check`. Run `bun run test` before review readiness unless the documented resource exception applies, then record exact focused results and CI coverage. Source-read/golden and CLI subprocess tests above are explicit because `test:changed` can miss them. Exact-head required CI and OAuth/security review remain merge gates, not inferred from focused tests.

## Ordering and risk

The four fetched contributor heads are separate work: #6154
`b3e68de2928ba72b9ffe57c8fbd13034ef5168b6` paces Codex quota reads;
#5831 `f3750ebc7eafb845dcf426ae070875601f5dc1b6` repairs Codex main
lock recovery; #5956 `b05e99d239eb0f87fe0fb2fd737a9fefeb612343`
adds Codex low-quota policy; #5099
`9473f496b19a335dee56cfa5d638ff446ced6d63` changes generic OAuth
failover. `git merge-tree --write-tree origin/dev refs/rt5/pr-N` reports no
conflict for #6154/#5831, conflicts for #5956 in test-layout manifests and
`src/types.ts`, and conflicts for #5099 in generic failover and Responses
retry modules. #5561 has no PR/head, so no #5561 merge conflict exists to
resolve. Reimplement on fresh `dev`; if #5099 lands first, resolve the shared
`adapter-dispatch.ts`/`adapter-continuation.ts`/`sidecar-execution.ts` call-site
hunks manually, retaining both providers' separate eligibility checks, then
rerun their focused suites. #5956 may touch `src/types/config.ts` and
`structure/config.md`; reconcile both field sets and rerun typecheck and
structure checks. #6154/#5831 affect Codex quota authorities, not this
selector, but can change shared structure docs. Suggested order follows
`000_roadmap.md`: #6154 → #5831 → #5099 → #5561 → #5956; #5099 and #5561
may be developed independently, then integrated serially.

Main risks: account IDs and model patterns are operator-owned routing policy;
do not silently infer model entitlement from quota or plan data. Preserve the
existing OAuth admission revision/credential checks, pre-output replay limits,
local-cli credential rule, and token redaction. Validate untrusted API, CLI and
disk settings at their boundaries; log bounded route names only. This touches
OAuth credential selection and therefore requires explicit security review
under `AGENTS.md`/`MAINTAINERS.md`.
