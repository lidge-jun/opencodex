# 360 — S11 L5/5: src/oauth/github-copilot.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**. Planning class: C3, bounded docs-only delegation; auth/provenance implementation retains C4 security care where noted below.
- Non-goals: No live login, token refresh, credential writes, timer redesign, endpoint/allowlist changes, altered cancellation/cadence, retry changes or new validation. Preserve public constant values and header object identity.
- Goal: Move GitHub device authorization, polling and refresh-grant transport into one leaf; retain Copilot token exchange, identity projection and public login/refresh orchestration at the old boundary.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated in Verification below (the 000 reference to 003 is stale; 002 is authoritative).
- Stop: this delegated turn stops after writing and statically checking this plan; no source edits, tests, git mutations, orchestration, loop or goal commands. The later executor stops on any changed behavior, missing binding, cycle, oversized leaf, failing guard or basis drift. Layer execution ends only at an open PR with recorded green exact-head CI; never merge.
- Escalation: send any extra file/layer requirement or boundary change to the parent. Do not expand this layer into adjacent cleanup or add an unplanned #b.

Basis: docs HEAD `4cc219549`; source `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. All source line references below are to that source snapshot. `git diff --numstat origin/dev -- src/oauth/github-copilot.ts` is empty. Lane audit: `devlog/_plan/260905_modular_debt_ledger/013_lane_providers_codex_oauth_routing.md:691`. No implementation proof is claimed here.

## Symbol inventory

Every top-level declaration is listed, including private declarations and import bindings. Inclusive start–end spans were extracted with `sg run --lang ts --kind <function_declaration|interface_declaration|type_alias_declaration|lexical_declaration> --json=compact src/oauth/github-copilot.ts` and checked against `git show origin/dev:src/oauth/github-copilot.ts` with numbered lines. Nested declarations are intentionally not top-level rows.

Consumers = unique **direct importing/re-exporting files**, not identifier occurrences or callers inside this module. Start from `rg -l -F 'github-copilot' src gui/src scripts tests`, inspect import/re-export clauses, resolve each relative specifier to this exact file, then intersect each named binding with `rg -l -w '<symbol>' src gui/src scripts tests`. Private declarations have zero external consumers; same-spelling symbols elsewhere are not consumers. Type-only imports count. Imported bindings themselves are local, not exports. Baseline: 6 direct files; test-only leaf imports for new identity assertions do not replace any original import.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `OAuthController, OAuthCredentials` | import binding(s) | 7–7 | no | 0 (local imports) | residual |
| `GITHUB_COPILOT_OAUTH_CLIENT_ID` | const | 10–10 | yes | 0 | `src/oauth/github-copilot-device.ts` |
| `GITHUB_COPILOT_DEFAULT_API_BASE` | const | 11–11 | yes | 1 | `src/oauth/github-copilot.ts (residual)` |
| `GITHUB_DEVICE_VERIFY_ORIGIN` | const | 12–12 | yes | 0 | `src/oauth/github-copilot-device.ts` |
| `GITHUB_DEVICE_VERIFY_PATH` | const | 13–13 | yes | 0 | `src/oauth/github-copilot-device.ts` |
| `DEVICE_CODE_URL` | const | 15–15 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `ACCESS_TOKEN_URL` | const | 16–16 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `COPILOT_TOKEN_URL` | const | 17–17 | no | 0 | `src/oauth/github-copilot.ts (residual)` |
| `GITHUB_USER_URL` | const | 18–18 | no | 0 | `src/oauth/github-copilot.ts (residual)` |
| `OAUTH_SCOPE` | const | 20–20 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `DEFAULT_POLL_INTERVAL_MS` | const | 21–21 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `DEFAULT_DEVICE_FLOW_TTL_MS` | const | 22–22 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `OAUTH_EXPIRY_SKEW_MS` | const | 23–23 | no | 0 | `src/oauth/github-copilot.ts (residual)` |
| `MIN_POLL_MS` | const | 24–24 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `TERMINAL_OAUTH_ERROR_CODES` | const | 26–26 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `IDENTITY_RETRY_DELAY_MS` | const | 27–27 | no | 0 | `src/oauth/github-copilot.ts (residual)` |
| `GITHUB_COPILOT_EDITOR_HEADERS` | const | 30–36 | yes | 1 | `src/oauth/github-copilot.ts (residual)` |
| `DeviceAuthorizationResponse` | interface | 38–47 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `GithubTokenResponse` | interface | 49–57 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `CopilotTokenResponse` | interface | 59–64 | no | 0 | `src/oauth/github-copilot.ts (residual)` |
| `GithubUserResponse` | interface | 66–70 | no | 0 | `src/oauth/github-copilot.ts (residual)` |
| `sleep` | function | 72–81 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `githubCopilotHttpError` | function | 84–86 | yes | 1 | `src/oauth/github-copilot-device.ts` |
| `buildGithubDeviceVerifyUrl` | function | 88–94 | yes | 1 | `src/oauth/github-copilot-device.ts` |
| `isAllowedGithubDeviceVerifyUrl` | function | 100–112 | yes | 1 | `src/oauth/github-copilot-device.ts` |
| `validateCopilotApiBaseUrl` | function | 118–139 | yes | 4 | `src/oauth/github-copilot.ts (residual)` |
| `resolveCopilotApiBaseUrl` | function | 141–143 | yes | 3 | `src/oauth/github-copilot.ts (residual)` |
| `requestDeviceAuthorization` | function | 145–181 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `pollGithubDeviceToken` | function | 183–245 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `refreshGithubAccessToken` | function | 247–279 | no | 0 | `src/oauth/github-copilot-device.ts` |
| `exchangeCopilotToken` | function | 281–313 | no | 0 | `src/oauth/github-copilot.ts (residual)` |
| `fetchGithubIdentityOnce` | function | 315–340 | no | 0 | `src/oauth/github-copilot.ts (residual)` |
| `fetchGithubIdentity` | function | 348–362 | no | 0 | `src/oauth/github-copilot.ts (residual)` |
| `credentialsFromGithubAccess` | function | 370–388 | no | 0 | `src/oauth/github-copilot.ts (residual)` |
| `loginGithubCopilot` | function | 390–411 | yes | 2 | `src/oauth/github-copilot.ts (residual)` |
| `refreshGithubCopilotToken` | function | 419–428 | yes | 2 | `src/oauth/github-copilot.ts (residual)` |

## Leaf partition

Structural decision: The 428-line OAuth module has a device-grant cluster and a Copilot exchange/identity cluster. Reject moving only pollGithubDeviceToken: it shares sleep, GitHub token response shape, access endpoint and status-only errors with other functions. Move the complete device/refresh cluster and its shared stateless primitives into github-copilot-device.ts, exporting only the internal operations the residual actually calls. This follows src/oauth/chatgpt-device.ts and src/oauth/kiro-credentials.ts. Blast radius: GitHub Copilot OAuth feature; later implementation needs C4 auth care and explicit security review (MAINTAINERS.md:60).

Pre-change/intended map: Current: src/oauth/index.ts:40, src/oauth/store.ts:30, src/providers/github-copilot-transport.ts:2 and src/server/responses/core.ts:140 → github-copilot.ts → OAuth types only. Intended: the same callers → github-copilot.ts → github-copilot-device.ts (zero imports); OAuthController/OAuthCredentials remain type-only imports in the facade. sleep and githubCopilotHttpError move down because both clusters call them. Editor headers/API origin validation remain residual and are not needed by the device leaf; therefore no return edge.

The leaf deliberately includes refreshGithubAccessToken with polling because both own ACCESS_TOKEN_URL and GithubTokenResponse. The public refreshGithubCopilotToken stays in the facade, so durable-grant dispatch, parallel exchange/identity lookup and identity-required persistence behavior retain their existing caller boundary.

### `src/oauth/github-copilot-device.ts` — 214 expected lines

Move source bands `src/oauth/github-copilot.ts:9`–10, `src/oauth/github-copilot.ts:12`–16, `src/oauth/github-copilot.ts:20`–22, `src/oauth/github-copilot.ts:24`–26, `src/oauth/github-copilot.ts:38`–58, `src/oauth/github-copilot.ts:72`–113, `src/oauth/github-copilot.ts:145`–280 (212 physical lines including existing inter-declaration comments/blanks). Symbols: `GITHUB_COPILOT_OAUTH_CLIENT_ID`, `GITHUB_DEVICE_VERIFY_ORIGIN`, `GITHUB_DEVICE_VERIFY_PATH`, `DEVICE_CODE_URL`, `ACCESS_TOKEN_URL`, `OAUTH_SCOPE`, `DEFAULT_POLL_INTERVAL_MS`, `DEFAULT_DEVICE_FLOW_TTL_MS`, `MIN_POLL_MS`, `TERMINAL_OAUTH_ERROR_CODES`, `DeviceAuthorizationResponse`, `GithubTokenResponse`, `sleep`, `githubCopilotHttpError`, `buildGithubDeviceVerifyUrl`, `isAllowedGithubDeviceVerifyUrl`, `requestDeviceAuthorization`, `pollGithubDeviceToken`, `refreshGithubAccessToken`.

Keep existing exported declarations exported. Add the `export` modifier (without changing a body/signature) only to these formerly private declarations needed by another production module: `requestDeviceAuthorization`, `pollGithubDeviceToken`, `refreshGithubAccessToken`, `sleep`. Every other private declaration stays private; none of the new internal exports is added to the facade.

Own imports (complete):

```ts
// None: this leaf has no imports.
```

### Residual `src/oauth/github-copilot.ts` — 219 expected lines

Keep these declarations: `GITHUB_COPILOT_DEFAULT_API_BASE`, `COPILOT_TOKEN_URL`, `GITHUB_USER_URL`, `OAUTH_EXPIRY_SKEW_MS`, `IDENTITY_RETRY_DELAY_MS`, `GITHUB_COPILOT_EDITOR_HEADERS`, `CopilotTokenResponse`, `GithubUserResponse`, `validateCopilotApiBaseUrl`, `resolveCopilotApiBaseUrl`, `exchangeCopilotToken`, `fetchGithubIdentityOnce`, `fetchGithubIdentity`, `credentialsFromGithubAccess`, `loginGithubCopilot`, `refreshGithubCopilotToken`.

Accounting: 428 original − 212 moved − 0 replaced import/header lines + 1 explicit import lines + 1 named re-export lines + 1 separator = **219**. Each leaf estimate is its source-band count + own import lines + two header/separator lines. These are physical-line estimates using the compact exact import blocks below, not a claim of measured implementation output. Preserve comments, allow readable multiline imports, and remeasure after formatting; no file may exceed 400. No residual >400 and no #b required by file length. No #a/#b/#c parts are added in this five-layer map. Original function bodies over 50 lines remain unchanged as an explicit pure-move exception; splitting their logic is out of scope.

## Re-export block

Insert at the existing feature boundary, using named re-exports only. This is preservation of an established path, not a new internal index barrel. Re-exports create no local bindings.

```ts
export { GITHUB_COPILOT_OAUTH_CLIENT_ID, GITHUB_DEVICE_VERIFY_ORIGIN, GITHUB_DEVICE_VERIFY_PATH, githubCopilotHttpError, buildGithubDeviceVerifyUrl, isAllowedGithubDeviceVerifyUrl } from "./github-copilot-device";
```

Retain these current exports as declarations in the original file (not copies): `GITHUB_COPILOT_DEFAULT_API_BASE`, `GITHUB_COPILOT_EDITOR_HEADERS`, `validateCopilotApiBaseUrl`, `resolveCopilotApiBaseUrl`, `loginGithubCopilot`, `refreshGithubCopilotToken`. Together with the block above this preserves the complete old type/value export set; leaf-private API is not added to the facade.

Explicit residual imports (add alongside any unchanged original imports):

```ts
import { requestDeviceAuthorization, pollGithubDeviceToken, refreshGithubAccessToken, sleep, githubCopilotHttpError, isAllowedGithubDeviceVerifyUrl } from "./github-copilot-device";
```

## Module-level state and cycles

TERMINAL_OAUTH_ERROR_CODES Set at 26 has exactly one owner: github-copilot-device.ts alongside refreshGithubAccessToken. It remains private, with identical members and construction timing relative to its dependent code. GITHUB_COPILOT_EDITOR_HEADERS (30–36), the sole shared object here, stays in the facade; do not clone or freeze it as part of this move. Client ID and verification origin/path move and re-export by binding. All other top-level constants have the owners shown in the inventory. sleep's t timer (75), poll deadline (189) and waitMs (190) remain invocation-local, with unchanged abort listeners. There is no global lock/cache/flight. Moving sleep/error helpers together with the device transport avoids leaf → facade cycles; do not create a general OAuth utilities module.

Lane 013 reported no static return-path cycle for this source. This plan's new local graph is acyclic by the dependency direction above; this is not a substitute for the executor's fresh whole-relative-graph return-path scan. Include type-only imports/re-exports, not merely runtime imports. New edges are Functional/Sequential coupling, not shared mutable Common state; preserve existing invocation ordering rather than adding locks or global owners. No leaf imports `./github-copilot` or any facade that routes back into itself. No lazy import workaround.

## Tests

Direct importer list, reproduced by `rg -l -F 'src/oauth/github-copilot' tests` (all **unchanged**, including import path and existing assertions):

- `tests/oauth/generic-oauth-failover.test.ts` — unchanged.
- `tests/providers/github-copilot/github-copilot-oauth.test.ts` — unchanged.

Text-oracle inventory: **none found** for this exact source path. Inspected basename/path matches and segmented `repoPath` forms for `readFileSync`, `Bun.file` and source-reader helpers, consistent with lane 013. There is therefore no source-read line to retarget and no explicit scan-list entry to add. A basename occurrence in `tests/fixtures/test-layout-expected.json` is test registration, not a source read. Generic recursive import-graph coverage is unchanged and discovers imports naturally. If implementation finds a computed/path-list source oracle not captured here, stop and extend the inventory with its exact read line before moving code; do not weaken it.

The two direct-import test files keep their existing behavioral imports unchanged; run the entire tests/providers/github-copilot domain for transport/account-origin integration. Preserve tests/providers/github-copilot/github-copilot-oauth.test.ts:47 URL rejection, :69 status-only error assertions, :129 slow_down cadence, :162 refresh failure privacy, :183 cancellation, :248 durable access-grant re-exchange and :263 terminal error allowlisting. Add an identity test there comparing the six moved public exports against ../../../src/oauth/github-copilot-device. Drive red once by replacing the facade's githubCopilotHttpError re-export with a temporary wrapper, restore, then green. Fetch remains read dynamically from globalThis during calls; do not capture it at module load and invalidate the existing fetch-mock tests. No test is converted into a real OAuth request.

These red-once mutations are future disposable-worktree verification steps, never persistent changes. They were not performed during drafting. Extend existing test files only; no new test file or test-layout entry is planned. `tests/lab/core-lab-boundary.test.ts` PROTECTED roots are never edited.

## Verification

Future implementation commands only; **none run in this docs-only task**. Execute against this layer's own tip, domains **providers/github-copilot, oauth**, not the eventual stack top.

```sh
bun run typecheck
bun test tests/providers/github-copilot tests/oauth/generic-oauth-failover.test.ts
bun run privacy:scan
wc -l src/oauth/github-copilot-device.ts src/oauth/github-copilot.ts
rg -l -F 'oauth/github-copilot' src gui/src scripts tests
# Resolve relative import/re-export paths and compare the original consumer file set.
# Full suite: lidge only, no local full-suite invocation; keep the full exit status/log.
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-oauth-github-copilot && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test'
```

For the 002 importer gate, the expected **existing** direct consumer set is 6: `src/oauth/index.ts`, `src/oauth/store.ts`, `src/providers/github-copilot-transport.ts`, `src/server/responses/core.ts`, `tests/oauth/generic-oauth-failover.test.ts`, `tests/providers/github-copilot/github-copilot-oauth.test.ts`. The rg line above is a candidate list, not the count: same-directory imports and aliases require the path resolution described in Symbol inventory. Compare file sets, not statement counts; added leaf imports in identity tests are intentional. No original consumer migrates away from this boundary. Typecheck must still resolve every old export.

Cycle verification: repeat lane 013 SG-GRAPH using `sg run --lang ts --kind import_statement --json=compact src` and `sg run --lang ts --kind export_statement --json=compact src`; resolve relative .ts/.tsx/index targets, include type edges, and search for a return path to the original or any new leaf. Require no new return path; record the scoped graph result. Do not install a new dependency tool for this layer.

The 002 conditional Lab gate is not triggered by these planned source paths (none is src/server, src/router.ts or src/lib). If the implementation touches one of those paths, that is an expansion requiring parent approval and `bun test tests/lab/core-lab-boundary.test.ts`; keep PROTECTED unchanged. All new leaves must stay free of a transitive Lab dependency regardless.

Record red then green for the guard named in Tests, typecheck exit 0, focused tests 0 failures, privacy scan exit 0, actual per-file line counts, full-suite exit 0 on lidge, the exact tested SHA and CI rollup. The remote worktree is parent-coordinated; confirm ownership before checkout and require its tested SHA to equal the PR head. Do not mask test exit status with an unguarded tail pipeline. Revalidate after any cascade.

## Accept criteria

1. Source still matches the stated basis or the plan is refreshed for every changed symbol before extraction. The actual source diff remains at most 500 added-plus-deleted lines; otherwise escalate before publication.
2. Every inventory declaration has exactly one owner; all function bodies/signatures and constant/type definitions are moved verbatim, apart from the necessary export modifiers and import paths. No public export is renamed, deleted, wrapped or newly invented.
3. Every current export remains importable from `src/oauth/github-copilot.ts`; moved values pass identity guards where applicable, and residual references are satisfied by real imports, not a re-export-only assumption.
4. Actual 1 new leaves and the residual are each ≤400 physical lines. Record counts rather than relying on these estimates. No hidden #b or unplanned source file is required.
5. The 12 public runtime exports keep identical names and bindings/behavior; the editor-header object remains single-owned, device polling waits before each request, and no credential persistence or network action is performed while drafting.
6. State/constant ownership matches this plan; fresh relative-import graph reports no new cycle, including type-only edges, and no new Lab reachability.
7. Existing tests/imports/source guards are retained without weakening; the specified guard is demonstrated red once and restored green. All instantiated 002 gates and exact-head CI are green with recorded evidence.
8. PR uses the template, correct base and complete five-layer map. No merge, release, deployment, dependency installation on the user's running service, or unrelated code change is included.

## PR

Title: `refactor(oauth): isolate GitHub device grant transport (split S11 L5/5)`

Branch: `codex/split-oauth-github-copilot`. Base: `dev`. Closes: **none**.

Use `.github/PULL_REQUEST_TEMPLATE.md` with Summary, Verification and Checklist. Put the measured move size and any parent-approved exception in Summary, evidence tied to this PR head in Verification, and include the stack map below. Review this layer's diff only. PR numbers are intentionally unassigned planning placeholders, not existing PR claims.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S11-L1 |  L1 | `codex/split-combos-types` | `dev` | isolate combo identifiers from validation |
| 2 | #TBD-S11-L2 |  L2 | `codex/split-codex-subagent-defaults` | `dev` | isolate format-preserving subagent TOML lexing |
| 3 | #TBD-S11-L3 |  L3 | `codex/split-codex-cli-install-provenance` | `dev` | separate install evidence from classification |
| 4 | #TBD-S11-L4 |  L4 | `codex/split-routing-trace` | `dev` | separate trace contracts and evidence codecs |
| 5 | #TBD-S11-L5 | **L5 — this layer** | `codex/split-oauth-github-copilot` | `dev` | isolate GitHub device grant transport |

Base: dev — no dependency on the layers below; no cascade obligation.

DEV-STACK-04: merges remain separately authorized; this task performs none.
