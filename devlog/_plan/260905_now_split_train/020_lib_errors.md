# S01 L2/3 — Error message predicates

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. Class: C3 boundary planning, docs-only here.
- Goal: extract the message-predicate owner into src/lib/error-message-predicates.ts (123 lines) and leave src/lib/errors.ts at 338 lines without changing classification precedence or payloads.
- Non-goals: no new error code, status, message matching, signature, dependency, renamed export, caller migration or unrelated classifier cleanup. Existing >50-line classification functions remain a stated pure-move exception.
- Verifier: 002_layer_map.md "Per-layer gate", instantiated below. No tests run in this drafting task.
- Stop: standalone layer verified at its tip, open PR with exact-head green CI/evidence recorded by the parent; never merge.
- Escalation: source drift, altered precedence/output, new cycle, unknown oracle, >500 changed source lines, or a required scope expansion. Any unreleased security finding belongs in ignored scratch, not this plan.

Basis: docs HEAD 4cc219549; origin/dev 1362b1a38, identical working-tree source for this file. Older tips in 000/001 are historical. Lane: 016_lane_cli_storage_usage_update_lab_scripts.md:682–695 in the modular-debt-ledger unit.

Structural map: 22 direct importing files. Examples src/lib/retry-after.ts:2 and src/bridge.ts:17; current errors.ts has no imports. classifyError (:149), inferHttpStatusFromAdapterMessage (:332), and httpStatusFromTerminalError (:412) share the predicates at :29–147. Intended graph: existing consumers → errors.ts → error-message-predicates.ts, with no imports in the leaf. Public boundary is errors.ts; blast radius is the lib module with unchanged downstream error handling.

Decision: extract all shared message predicates and their policy constants together, leaving status/payload composition in the original owner. Doing nothing leaves 457 lines; deleting/configuring changes policy; extracting classifyError alone would require separate shared types and predicates to avoid return imports. rg for isSubscriptionGateMessage and related predicate names in src/lib identifies this owner, not a reusable alternative. Do not move parseRetryAfterFromMessage into src/lib/retry-after.ts: that module already imports errors.ts:2, creating a return edge. Domain-named sibling convention matches src/lib/provider-url.ts, src/lib/retry-after.ts and src/lib/debug-settings.ts. Retaining named compatibility re-exports is explicitly required by this train; no new internal index barrel is added.

## Symbol inventory

Inclusive ranges at origin/dev:src/lib/errors.ts; rg top-level declarations and source closing lines establish exact ranges. Consumers are distinct external importing files with an exact rg -l -w symbol match, not call counts. Candidate rg -l errors src gui/src scripts tests is filtered by resolved relative static/dynamic import and mock paths. Private names have zero external consumers. No original imports. R = src/lib/errors.ts; P = src/lib/error-message-predicates.ts.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| OcxErrorPayload | interface | 1–5 | yes | 1 | R |
| upstreamErrorMessageFromPayload | function | 8–23 | yes | 2 | R |
| CYBER_POLICY_ERROR_CODE | const string | 26–26 | yes | 9 | P |
| CYBER_POLICY_FALLBACK_MESSAGE | const string | 27–27 | yes | 2 | P |
| isCyberPolicyCode | function | 29–31 | yes | 12 | P |
| cyberPolicyErrorType | function | 34–37 | yes | 6 | P |
| isCyberPolicyMessage | function | 45–56 | yes | 7 | P |
| isSubscriptionGateMessage | function | 58–69 | no; leaf-only export after move | 0 | P |
| isLocalAclHardeningMessage | function | 71–88 | no; leaf-only export after move | 0 | P |
| isAuthenticationMessage | function | 90–116 | no; leaf-only export after move | 0 | P |
| isPermissionMessage | function | 118–128 | no; leaf-only export after move | 0 | P |
| isClientClosedMessage | function | 138–147 | yes | 1 | P |
| classifyError | function | 149–290 | yes | 12 | R |
| isRateLimitOrQuotaFailureMessage | function | 296–313 | yes | 3 | R |
| parseRetryAfterFromMessage | function | 316–329 | yes | 2 | R |
| inferHttpStatusFromAdapterMessage | function | 332–382 | yes | 2 | R |
| adapterFailureFromMessage | function | 385–409 | yes | 5 | R |
| httpStatusFromTerminalError | function | 412–457 | yes | 4 | R |

## Leaf partition

One new sibling: src/lib/error-message-predicates.ts.

- Symbols: CYBER_POLICY_ERROR_CODE, CYBER_POLICY_FALLBACK_MESSAGE, isCyberPolicyCode, cyberPolicyErrorType, isCyberPolicyMessage, isSubscriptionGateMessage, isLocalAclHardeningMessage, isAuthenticationMessage, isPermissionMessage, isClientClosedMessage.
- Own imports: none. The policy constant is colocated with its users. Add export modifiers to the four formerly private predicates strictly for the residual's production calls; do not expose those four through errors.ts.
- Move exact source chunk src/lib/errors.ts:25–147, including comments and blank lines: 123 lines. Leaf remains 123 lines; modifiers do not add physical lines.
- Residual keeps OcxErrorPayload, payload parsing, classification, retry-after parsing, status inference and adapter/terminal composition. Prepend the import, blank line, one re-export line, blank line below: 457 − 123 + 4 = 338 lines.
- Total layout: 123 + 338 = 461, four import/export/layout lines above the baseline. Source churn expected 127 additions + 123 deletions = 250, below 500. No #b needed. Shared zero-external-consumer predicates move with the public predicates they support; callers do not migrate.

## Re-export block

Exact new named compatibility export (six original exports):

    export { CYBER_POLICY_ERROR_CODE, CYBER_POLICY_FALLBACK_MESSAGE, isCyberPolicyCode, cyberPolicyErrorType, isCyberPolicyMessage, isClientClosedMessage } from "./error-message-predicates";

No type re-export is needed: OcxErrorPayload remains defined/exported in errors.ts. Retain its seven other exported functions unchanged: upstreamErrorMessageFromPayload, classifyError, isRateLimitOrQuotaFailureMessage, parseRetryAfterFromMessage, inferHttpStatusFromAdapterMessage, adapterFailureFromMessage, httpStatusFromTerminalError.

Exact explicit local import, before the export with a blank line between and after:

    import { CYBER_POLICY_ERROR_CODE, isCyberPolicyCode, isCyberPolicyMessage, isClientClosedMessage, isSubscriptionGateMessage, isLocalAclHardeningMessage, isAuthenticationMessage, isPermissionMessage } from "./error-message-predicates";

The re-export does not bind identifiers. classifyError needs CYBER_POLICY_ERROR_CODE and six message predicates; status inference/terminal mapping also need these imports. CYBER_POLICY_FALLBACK_MESSAGE and cyberPolicyErrorType have no residual local calls and are re-exported without unused imports.

## Module-level state and cycles

- No top-level let, Map, Set, WeakMap, lock, timer or other mutable singleton exists in the original or proposed leaf.
- CYBER_POLICY_ERROR_CODE (:26) and CYBER_POLICY_FALLBACK_MESSAGE (:27) have exactly one owner, P. They remain identical immutable strings, re-exported without redeclaration.
- Predicate regular expressions are function-local, as before. parseRetryAfterFromMessage's patterns (:317) are also invocation-local and remain in R; do not hoist them as incidental cleanup.
- No leaf-to-facade import, including type-only imports. P needs neither OcxErrorPayload nor classifyError; R keeps their ownership. This avoids errors.ts → P → errors.ts and errors.ts → retry-after.ts → errors.ts cycles.
- New edges are functional predicate calls. Existing classification precedence is not moved or reordered. No initialization ordering dependency is introduced. P has no imports, so the new edge cannot create a cycle or reach Lab.

## Tests

Complete direct importing-test list from rg -l 'src/lib/errors|lib/errors\.ts' tests:

| test file | import line | disposition |
|---|---:|---|
| tests/lib/acl-error-classification.test.ts | 5 | unchanged, original path |
| tests/providers/cursor/cursor-errors.test.ts | 8 | unchanged, original path |
| tests/providers/cyber-policy-error-fidelity.test.ts | 15 | unchanged, original path |
| tests/server/errors-adapter-failure.test.ts | 6 | unchanged, original path |
| tests/server/error-fidelity.test.ts | 3 | unchanged, original path |
| tests/server/server-403-permission-e2e.test.ts | 8 | unchanged, original path |

Qualified-path search plus rg -n 'errors\.ts' tests finds no direct source reader for this file (the kiro-errors.ts comment is unrelated). Transitive source reader tests/lab/core-lab-boundary.test.ts:69 follows the static graph; unchanged and automatically includes P. No retarget-to-leaf or add-leaf-to-scan-list is required. Public-path behavioral tests must not import the new private predicate leaf merely to satisfy coverage.

Guards to drive red once in implementation C: temporarily make isLocalAclHardeningMessage return false and run tests/lib/acl-error-classification.test.ts; its local-hardening case at :8 must fail. Restore. Temporarily add a static ../lab/paths import to P, run tests/lab/core-lab-boundary.test.ts and observe the transitive guard :284 fail; remove and return green without editing PROTECTED. Existing mixed authentication/subscription precedence tests/server/errors-adapter-failure.test.ts:55 and narrow client-close case :93 must remain unchanged and green. No red mutation is performed by this drafting task.

## Verification

Future executor commands, instantiating 002 at this layer tip, in its dedicated worktree:

    bun run typecheck
    bun test tests/lib/acl-error-classification.test.ts tests/providers/cursor/cursor-errors.test.ts tests/providers/cyber-policy-error-fidelity.test.ts tests/server/errors-adapter-failure.test.ts tests/server/error-fidelity.test.ts tests/server/server-403-permission-e2e.test.ts
    bun run privacy:scan
    bun test tests/lab/core-lab-boundary.test.ts
    wc -l src/lib/errors.ts src/lib/error-message-predicates.ts
    rg -n 'from "[^"]*/errors"' src gui/src scripts tests | wc -l
    git diff --check
    git diff --numstat origin/dev...HEAD -- src/lib/errors.ts src/lib/error-message-predicates.ts

Domains: lib, providers/cursor, providers, server, plus mandatory lab boundary. Recorded static-from baseline: 33 matching lines (this basename-only gate includes other errors modules); compare before/after and also compare the path-resolved importer census to 22. No existing consumer is rewritten. Compare all 14 public exports (13 runtime, one type) across the move. Confirm P imports nothing with rg -n '^(import|export).*from|^import ' src/lib/error-message-predicates.ts (no matches), and compare every moved body/comment allowing only four export modifiers. Combined with the one outward facade edge, zero leaf imports prove no new cycle.

Remote full suite only, preserving the actual exit status rather than hiding it behind tail:

    ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-lib-errors && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test'

Parent coordinates the remote checkout, verifies the printed SHA equals this PR's head and records full-suite exit/results plus exact-head CI rollup. Do not run a local full suite. These are planned gates, not test claims for this docs-only task.

## Accept criteria

1. Exactly one new source leaf, P, owns the 10 listed declarations; eight declarations remain in R. No function-body, condition-order, code/message or signature changes.
2. Six moved public exports resolve from errors.ts; its eight retained exports remain intact. Four new leaf-only predicate exports are not re-exported by the original boundary.
3. wc shows at most 400 lines per file, planned P=123 and R=338; source churn stays at most 500 changed lines. Count drift is explained before readiness.
4. P has zero imports and no mutable state; policy constants are defined once. OcxErrorPayload remains in R and creates no reverse type edge.
5. All focused checks, typecheck, privacy scan and lab boundary exit 0; both deliberate red drives fail at the intended assertion and pass after restoration.
6. Original-path importer census stays 22; remote full suite and full exact-head CI are green and bound to the recorded PR head. No local full-suite execution.
7. Base is the current L1 branch, ancestry includes its current tip, repository PR template is complete, and nothing is merged or released.

## PR

Title: refactor(lib): isolate error message predicates (split S01 L2/3)

Branch: codex/split-lib-errors. Base: dev. Closes: none.

Use .github/PULL_REQUEST_TEMPLATE.md Summary, Verification, Checklist sections. Include this DEV-STACK-03 table and exact-head gate evidence. Review only this layer's diff. PR numbers are intentional pre-publication placeholders.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 3 | #TBD-S01-L3 | upstream retry | codex/split-lib-upstream-retry | dev | wait/body ownership |
| 2 | #TBD-S01-L2 | errors — this layer | codex/split-lib-errors | dev | message predicates |
| 1 | #TBD-S01-L1 | redact | codex/split-lib-redact | dev | folding and offset identity |

Base: dev — no dependency on the layers below; no cascade obligation.
