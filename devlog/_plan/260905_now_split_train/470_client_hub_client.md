# S14 L3 — Bounded hub transport and decoding

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 docs-only architecture planning with security-sensitive boundary review required for execution. Parent owns orchestration, loop and goal state.
- Goal: move existing bounded request/decoding primitives and their error identity from `src/client/hub-client.ts` to a sibling, keeping protocol adapters and the old public import path. Basis: docs `4cc219549`; source `origin/dev = 1362b1a38`, 481 lines. All source anchors below use that source basis.
- Non-goals: no transport, credentials, URL policy, validation, deadline, catalog, key-rotation or wire-contract changes; no live hub calls, generic HTTP client, new dependencies or consolidation with the management relay.
- Verifier: `002_layer_map.md` → **Per-layer gate**, instantiated below. Drafting uses only read-only source inspection and doc checks; no tests or production imports execute.
- Stop: executor finishes with standalone L3 evidence, exact-head CI green and its open PR; never merge. This delegation stops after its assigned docs are checked.
- Escalation: upstream drift, new source oracle, cycle, >400 result or >500 changed source lines requires parent re-plan. Any required auth/credential/policy behavior change is a separate C4 scope, never bundled into the move. Unreleased security findings go to permitted scratch via the parent, not this public devlog.

Structural decision: lane 016:599–611 names transport/decoding versus protocol adapters. Current map: `src/client/connect.ts:38–53` and three test importers → `hub-client.ts` → catalog limit, bounded-body, abort and remote protocol (`hub-client.ts:1–3,24–28`). Intended map: same consumers → retained `hub-client.ts` → `hub-client-transport.ts` → existing bounded-body/abort owners; catalog/remote protocol stay in the residual. Feature blast radius includes connection and its server rotation round-trip test, not server implementation. Do nothing/delete/configure cannot preserve the protocol surface while removing excess lines. Extracting pairing/rotation first would require sharing transport/error declarations anyway and cost more churn. Reusing `hub-relay.ts` is rejected: that module has relay-specific headers/policy (`src/client/hub-relay.ts:1–29`) rather than these client contracts. Concern-named siblings match `hub-relay.ts`, `machine-auth.ts` and `machine-api.ts`. Preserve the remote lifecycle source-of-truth at `structure/09_client-integrations.md:118–120`.

## Symbol inventory

Ranges: numbered `git show origin/dev:src/client/hub-client.ts` and ast-grep top-level declaration ranges; comments excluded from syntax ranges. All owned declarations listed; imports are dependencies. Consumer counts are distinct external import files from `rg -l -w '<symbol>' src gui/src scripts tests`, filtered by imports resolving to this module, excluding self. Same-name private functions/constants in unrelated modules are not consumers. File fan-in: **4** (1 production, 3 tests).

Aliases: `T` = `src/client/hub-client-transport.ts` (new); `R` = `src/client/hub-client.ts` (residual).

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| isPairingTransportPermitted | function | 12–23 | no | 0 | R |
| READY_BODY_LIMIT | const number | 30–30 | no | 0 | R |
| MANAGEMENT_BODY_LIMIT | const number | 31–31 | no | 0 | R |
| DEFAULT_TIMEOUT_MS | const number | 32–32 | no | 0 | T |
| OneTimeConnectCredential | type | 34–36 | yes | 1 | R |
| ConnectGuiSession | interface | 38–43 | yes | 1 | R |
| IssuedClientKey | interface | 45–50 | yes | 1 | R |
| StartedClientKeyRotation | interface | 52–55 | yes | 0 | R |
| HubClientError | class | 57–67 | yes | 2 | T |
| credentialString | function | 69–75 | no | 0 | T |
| safeTimeout | function | 77–81 | no | 0 | T |
| fetchBounded | async function | 83–109 | no | 0 | T |
| boundedText | async function | 111–132 | no | 0 | T |
| jsonCompatibleContentType | function | 134–137 | no | 0 | R |
| validateRemoteCatalog | function | 139–158 | no | 0 | R |
| parseJson | function | 160–166 | no | 0 | T |
| normalizeHubOrigin | function | 168–189 | yes | 2 | T |
| fetchHubReady | async function | 191–222 | yes | 2 | R |
| htmlMeta | function | 224–232 | no | 0 | R |
| exchangeConnectPairingGrant | async function | 234–267 | yes | 2 | R |
| parseIssuedClientKey | function | 269–279 | no | 0 | R |
| issueClientKey | async function | 281–319 | yes | 2 | R |
| revokeClientKey | async function | 321–346 | yes | 1 | R |
| rotationManagementHeaders | function | 348–360 | no | 0 | R |
| assertRotationAuthorityOrigin | function | 362–366 | no | 0 | R |
| startClientKeyRotation | async function | 368–390 | yes | 2 | R |
| commitClientKeyRotation | async function | 392–407 | yes | 2 | R |
| abortClientKeyRotation | async function | 409–424 | yes | 1 | R |
| downloadClientCatalog | async function | 426–466 | yes | 3 | R |
| probeClientKeyId | async function | 468–481 | yes | 1 | R |

All single-consumer exports resolve to `src/client/connect.ts:38–53`. `HubClientError` additionally has `tests/clients/remote-catalog.test.ts:2`; origin/ready/pairing/issue additionally have `tests/clients/client-connect.test.ts:8–14`; rotation start/commit additionally have `tests/server/api-keys-routes.test.ts:9`; catalog has both client test consumers. The class constructor at 58–66 is a class member, not a separate top-level declaration, and moves intact with its class.

## Leaf partition

1. **`src/client/hub-client-transport.ts` — expected 113 lines, ceiling 400.** Own `DEFAULT_TIMEOUT_MS`, `HubClientError`, `credentialString`, `safeTimeout`, `fetchBounded`, `boundedText`, `parseJson`, `normalizeHubOrigin`. Move exact ranges **32–33, 57–133, 160–190**, including separators: 2 + 77 + 31 = **110 moved lines**. Export the helpers needed by R, while leaving the default timeout private. Only two imports plus one separator:

   ```ts
   import { readBoundedResponseBytes } from "../lib/bounded-body";
   import { clearableDeadline } from "../lib/abort";
   ```

2. **Residual `src/client/hub-client.ts` — expected 379 lines, ceiling 400.** Retain all R declarations, including four public types, protocol-specific origin checks, readiness, pairing, issuance/revocation/rotation, catalog validation, catalog download and key-id probe. Remove the two moved imports at old lines 2–3; retain `MAX_REMOTE_CATALOG_BYTES` and all remote protocol imports. Add the ten physical wiring lines below (one export plus nine-line import). Accounting: **481 − 110 − 2 + 10 = 379**; leaf 110 + 3 = 113; total 492 = original 481 + 11 wiring lines. No #b needed; the residual remains below 400 without changing protocol bodies. Expected parent-relative source numstat churn about 235 lines, to be measured before PR readiness.

Owner search: `rg -n 'fetchBounded|boundedText|credentialString|safeTimeout|parseJson|normalizeHubOrigin' src/client` finds this owner, not an equivalent client leaf. Reuse the already-imported bounded-body and abort modules; do not copy them or bring catalog/server dependencies into T. Helpers become leaf exports because the retained production protocol functions call them, not to expose internals solely for tests.

## Re-export block

Exact residual wiring:

```ts
export { HubClientError, normalizeHubOrigin } from "./hub-client-transport";
import {
  HubClientError,
  boundedText,
  credentialString,
  fetchBounded,
  normalizeHubOrigin,
  parseJson,
  safeTimeout,
} from "./hub-client-transport";
```

There are **no `export type ... from` lines** because all four public type/interface declarations remain in R: `OneTimeConnectCredential`, `ConnectGuiSession`, `IssuedClientKey`, `StartedClientKeyRotation`. Also retain the exported declarations of `fetchHubReady`, `exchangeConnectPairingGrant`, `issueClientKey`, `revokeClientKey`, `startClientKeyRotation`, `commitClientKeyRotation`, `abortClientKeyRotation`, `downloadClientCatalog`, `probeClientKeyId`. This preserves all **15** original exports without renames/wrappers. Re-export binds neither the class nor the normalizer locally; both require the explicit import. New helper exports do not become exports of the original path. The residual's named compatibility exports are required by this train, not a new internal barrel.

## Module-level state and cycles

No top-level mutable collection, `let`, lock, timer or singleton (lane 016:606, verified declarations). Immutable scalar ownership: `READY_BODY_LIMIT` at 30 and `MANAGEMENT_BODY_LIMIT` at 31 stay solely in R; `DEFAULT_TIMEOUT_MS` at 32 moves solely to T. The `slugs` Set at 147 is invocation-local to R's catalog validator; it is not shared state. `headerDeadline` at 91 stays per invocation in T's `fetchBounded`, with both clears (98 and 107) unchanged.

The same `HubClientError` class must be owned **only by T** and re-exported, never recreated/subclassed in R. Otherwise `instanceof` checks at old lines 104 and 478 and existing consumers would diverge. Putting that class in R and importing it back into T would create R → T → R; moving the class with transport removes that cycle. T imports neither R nor R's protocol types. Existing helpers use only their current Web/Bun types, so no type-only reverse edge is necessary.

New R → T coupling is functional; request/header deadline sequencing is existing temporal behavior and stays wholly inside the transport implementation. R's validation remains at the existing HTTP/credential boundary—do not add or remove checks merely because the internal file boundary changes. Lane 016:607 found no original return cycle; executor repeats its method G over relative static/type imports/exports and literal dynamic imports and requires no return path through R or T. A leaf import inventory must remain exactly the two imports above. No server/router/lib source or protected Lab root is edited.

## Tests

Exact direct-test `rg -l 'client/hub-client["\x27]' tests` list:

| test file | import/read anchor | disposition |
|---|---|---|
| tests/clients/remote-catalog.test.ts | import at 2 | unchanged; catalog behavior and old-path class identity |
| tests/clients/client-connect.test.ts | import block 8–14 | unchanged; origin, ready, pairing, issuance and connect lifecycle |
| tests/server/api-keys-routes.test.ts | import at 9 | unchanged; server-to-client rotation round trip at 98 |

No test reads **`src/client/hub-client.ts`** as source after basename, qualified-path and path-segment searches. `tests/server/api-keys-routes.test.ts:262` is a real source oracle, but it reads **`src/server/management/oauth-account-routes.ts`**, not the hub client; unchanged. Other `readFileSync` calls in client-connect inspect generated config/catalog/token artifacts (e.g. 272, 287, 612), not source; unchanged. No `retarget-to-leaf` or `add-leaf-to-scan-list` action is needed. Keep test imports at the old public path to verify the re-exported error class.

Guards to drive red once later: mutate the moved oversize-result check corresponding to old line 124 and require `tests/clients/remote-catalog.test.ts:93` (forged Content-Length/oversized chunks) to fail; restore. Give catalog requests a whole-request deadline instead of the existing headers-only handling and require the streaming-progress test at line 11 to fail; restore. Existing tests at 39 (inactivity), 73–90 (malformed JSON and class identity), 112 (exact cap), 121 (unconditional requests), 136 (304/content type), plus client-connect 59, 88 and 131 (origin and authority boundaries) must remain intact. Only disposable test fixtures may be used; no live credential exchange or real hub writes. This is future verification, not a claimed red/green run.

## Verification

Later executor only, in the L3 worktree:

```sh
bun run typecheck
bun test tests/clients/remote-catalog.test.ts tests/clients/client-connect.test.ts tests/server/api-keys-routes.test.ts
bun run privacy:scan
wc -l src/client/hub-client-transport.ts src/client/hub-client.ts
rg -n 'from "[^"]*/hub-client"' src gui/src scripts tests
rg -n '^import|^export .* from ' src/client/hub-client-transport.ts src/client/hub-client.ts
git diff --numstat origin/dev...HEAD -- src/client/hub-client.ts src/client/hub-client-transport.ts
```

Domains: `tests/clients` and `tests/server` (specific file, not a server-wide source change). Original fan-in stays exactly 4, with consumer identities above. Check export/type equality against the inventory, including constructor identity across leaf/public path, and repeat method G. 002's core-Lab conditional is not triggered by the source touch set; do not change `PROTECTED` roots. Expand scope only after parent approval and include the guard if server/router/lib source is added.

Full suite only on lidge at the published exact L3 SHA, verify remote HEAD matches that tip and preserve pipeline failure:

```sh
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-client-hub-client && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Record actual focused/typecheck/privacy/remote exits, restored negative controls and full exact-head CI rollup. Explicit security review under `MAINTAINERS.md:60–61` covers unchanged credential/origin/deadline boundaries and class identity. No local full suite and no test runs, code imports, git mutations or hub traffic during drafting.

## Accept criteria

1. All 30 owned declarations are assigned once, with all 15 original public exports preserved; moved bodies/signatures/comments remain identical except required leaf `export` keywords.
2. Both files ≤400 (expected T=113, R=379); actual parent-relative source churn ≤500 or parent re-plan; no #b debt remains.
3. `HubClientError` has one class owner and identical constructor identity from the old and new paths; old imports resolve without consumer rewrites and internal helper exports do not leak through R.
4. No R/T cycle or type-only back edge; no new singleton or duplicated timeout/body-limit owner; imports in T are exactly bounded-body and abort.
5. Origin, credential, redirect, size, UTF-8, timeout, content-type, unconditional-catalog and rotation checks stay at their current boundaries; specified negative controls fail once, are restored, and focused tests/typecheck/privacy pass.
6. Explicit security review, remote full suite and exact-head CI are recorded for L3 independently; base is L2, no unrelated implementation or merge is included.

## PR

Title: `refactor(client): isolate bounded hub transport and decoding (split S14 L3/3)`

Branch: `codex/split-client-hub-client`. Base: `dev`. Closes: none.

Fill every `.github/PULL_REQUEST_TEMPLATE.md` section (Summary, Verification, Checklist), including actual security review evidence. DEV-STACK-03 map; replace PR placeholders after creation:

| # | PR | Layer / branch | Base | Review focus |
|---|---|---|---|---|
| 3 | #<S14-L3> | hub transport / codex/split-client-hub-client — this PR | dev | transport and error identity |
| 2 | #<S14-L2> | provider readers / codex/split-cli-provider | dev | read handlers and argument parsing |
| 1 | #<S14-L1> | status probes / codex/split-cli-status | dev | diagnostic probes and old exports |

Base: dev — no dependency on the layers below; no cascade obligation.

Review only this layer's diff. Verify its own base, ancestry and exact-head evidence; this train does not authorize any merge.
