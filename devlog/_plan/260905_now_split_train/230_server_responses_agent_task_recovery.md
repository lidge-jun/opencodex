# S07 L3/4 — Agent-task envelope codec

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 boundary planning, with explicit security review of the unchanged credential/assignment boundary before implementation readiness.
- Goal: move envelope recognition, assignment validation and injection into one codec sibling while leaving admission, transport and cache orchestration in their existing owner.
- Non-goals: changing credentials, fixed endpoint, JWT policy, byte limits, plaintext handling, cache lifetime/key construction, retry/abort order, or security behavior. No code, test, Git or orchestration execution in this delegated docs task.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below.
- Stop: complete this bounded plan; execution later stops at an exact-head green open PR, not merge. Upstream L1's unresolved scope decision is inherited, not bypassed.
- Escalation: changed admission or validation order, duplicated cache/key/Set, a leaf >400, any cyclic import, non-move security change or required file scope expansion. Parent approval required; no extra layer silently added.

Basis: docs HEAD `4cc219549`; source `origin/dev` = `1362b1a38`. Working-tree source matches the 498-line basis. Lane: `devlog/_plan/260905_modular_debt_ledger/011_lane_server_responses.md:434`.

Structural map: `src/server/responses/core.ts:312` and five tests -> recovery module -> `agent-task-recovery-cache.ts`, `encrypted-payload.ts`, OAuth parsing, auth-cors, bounded body and crypto. Intended: recovery module -> new envelope codec -> existing encrypted-payload owner; admission and transport remain residual. This is a local server Responses-feature partition, not a new service. Reject a second recovery store and wholesale transport/admission extraction: neither is needed to meet 400, and both increase credential/lifetime review scope. Reuse `structurallyValidFernetTokens`, not a copied recognizer. Codec owns the existing unknown-input boundary checks, with no added internal validation.

## Symbol inventory

Inclusive declaration spans measured from ast-grep declaration kinds, checked against `git show origin/dev:src/server/responses/agent-task-recovery.ts | nl -ba` and anchored `rg`. Imports 1–11 are dependencies. Consumers = distinct external direct importer/re-exporter files whose resolved literal module path targets this file and whose contents match `rg -l -w SYMBOL`, across `src gui/src scripts tests`. Private declarations have 0 external consumers. Fan-in **6** files (core + five tests).

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| RECOVERY_ENDPOINT | const | 15–15 | no | 0 | residual agent-task-recovery.ts |
| RECOVERY_TOOL | const | 16–16 | no | 0 | residual agent-task-recovery.ts |
| RECOVERY_PROMPT | const | 17–20 | no | 0 | residual agent-task-recovery.ts |
| CODEX_ORIGINATORS | const Set | 21–27 | no | 0 | residual agent-task-recovery.ts |
| CODEX_OAUTH_CLIENT_ID | const | 28–28 | no | 0 | residual agent-task-recovery.ts |
| OPENAI_TOKEN_ISSUERS | const Set | 29–29 | no | 0 | residual agent-task-recovery.ts |
| OPENAI_TOKEN_AUDIENCE | const | 30–30 | no | 0 | residual agent-task-recovery.ts |
| MAX_CIPHERTEXT_BYTES | const | 31–31 | no | 0 | agent-task-envelope.ts |
| MAX_ASSIGNMENT_BYTES | const | 32–32 | no | 0 | agent-task-envelope.ts |
| MAX_RECOVERY_RESPONSE_BYTES | const | 33–33 | no | 0 | residual agent-task-recovery.ts |
| CACHE_SCOPE_KEY | const Buffer | 34–34 | no | 0 | residual agent-task-recovery.ts |
| AgentTaskRecoveryOptions | interface | 36–41 | yes | 0 | residual agent-task-recovery.ts |
| agentTaskRecoveryConfig | function | 43–58 | yes | 1 | residual agent-task-recovery.ts |
| AgentEnvelope | interface | 60–70 | no | 0 | agent-task-envelope.ts |
| ROUTING_HEADER | const RegExp | 72–72 | no | 0 | agent-task-envelope.ts |
| findEnvelope | function | 74–157 | no | 0 | agent-task-envelope.ts |
| stripMatchingEnvelope | function | 159–169 | no | 0 | agent-task-envelope.ts |
| validateAssignment | function | 171–178 | no | 0 | agent-task-envelope.ts |
| injectAssignment | function | 180–201 | no | 0 | agent-task-envelope.ts |
| RecoveryAdmission | interface | 203–206 | no | 0 | residual agent-task-recovery.ts |
| isNativeChatGptAccessToken | function | 208–233 | no | 0 | residual agent-task-recovery.ts |
| recoveryAdmission | function | 235–269 | no | 0 | residual agent-task-recovery.ts |
| AdmittedRecovery | interface | 271–275 | no | 0 | residual agent-task-recovery.ts |
| admittedRecovery | function | 277–301 | no | 0 | residual agent-task-recovery.ts |
| recoveryPayload | function | 303–332 | no | 0 | residual agent-task-recovery.ts |
| sseDataPayloads | function | 334–357 | no | 0 | residual agent-task-recovery.ts |
| assignmentFromRecoverySse | function | 359–415 | no | 0 | residual agent-task-recovery.ts |
| requestRecovery | function | 417–458 | no | 0 | residual agent-task-recovery.ts |
| recoverEncryptedAgentTask | function | 460–484 | yes | 1 | residual agent-task-recovery.ts |
| discardEncryptedAgentTaskRecovery | function | 486–494 | yes | 1 | residual agent-task-recovery.ts |
| resetAgentTaskRecoveryState | function | 496–498 | yes | 5 | residual agent-task-recovery.ts |

## Leaf partition

One new sibling: `src/server/responses/agent-task-envelope.ts`. Symbols: `MAX_CIPHERTEXT_BYTES`, `MAX_ASSIGNMENT_BYTES`, `AgentEnvelope`, `ROUTING_HEADER`, `findEnvelope`, `stripMatchingEnvelope`, `validateAssignment`, `injectAssignment`. Move original **31–32 and 60–201** = **144 lines**. Add one import and one blank = **146 lines**. Its own import:

```ts
import { structurallyValidFernetTokens } from "./encrypted-payload";
```

Export the internal leaf contract `AgentEnvelope`, `findEnvelope`, `validateAssignment`, `injectAssignment`; keep limits, regex and `stripMatchingEnvelope` private. The public facade does not expose them. `Buffer` remains the existing Bun global; no dependency or Node-only execution model is introduced.

Residual `src/server/responses/agent-task-recovery.ts`: **498 - 144 + 2 = 356 lines**. All remaining source text is unchanged, including original imports; add only the two local imports below. Total **146 + 356 = 502 = 498 + 4**. Expected raw diff 144 deletions + 148 additions = 292 before formatter changes. No #b required. Lane 011 also identified response codecs, but moving them is unnecessary for this layer's file limit; leave them beside transport instead of expanding the diff.

Convention/equivalent-owner search: existing `src/server/responses/{agent-task-recovery-cache,encrypted-payload,input-admission,context-overflow}.ts` are named sibling leaves. The existing recovery cache at `agent-task-recovery-cache.ts:21–23` is reused without edits; no generic helpers/index file, duplicate envelope parser or second cache.

## Re-export block

All five existing public declarations remain in the residual: `AgentTaskRecoveryOptions`, `agentTaskRecoveryConfig`, `recoverEncryptedAgentTask`, `discardEncryptedAgentTaskRecovery`, `resetAgentTaskRecoveryState`. The exact added public re-export block is **empty** because no public declaration moves. Do not widen the public API by re-exporting newly leaf-exported internals.

Explicit local imports required by residual admission, payload, SSE and recovery functions:

```ts
import type { AgentEnvelope } from "./agent-task-envelope";
import { findEnvelope, validateAssignment, injectAssignment } from "./agent-task-envelope";
```

Do not replace these with `export { ... } from`: that supplies no local bindings. The public reset function continues to invoke the existing cache reset; no facade wrapper replacement or alias change is planned.

## Module-level state and cycles

- `CODEX_ORIGINATORS` at `src/server/responses/agent-task-recovery.ts:21–27`: sole owner remains residual; same Set identity and members.
- `OPENAI_TOKEN_ISSUERS` at line 29: sole owner remains residual.
- `CACHE_SCOPE_KEY` at line 34: sole owner remains residual, exactly one `randomBytes(32)` per module initialization. It must not move into a function, leaf, or new reset hook.
- `ROUTING_HEADER` at line 72: sole owner becomes envelope leaf; preserve flags (no global/sticky state) and exact expression. Both matching/stripping functions use this one instance.
- No other top-level mutable Map/WeakMap/lock/timer. All scalar constants are assigned in the inventory. Request-local AbortController/timeout at 423–427 stay residual and retain `finally` cleanup.
- Existing cache Maps and flights live only in `agent-task-recovery-cache.ts:21–23`; no extraction duplicates them or changes waiter accounting.

Potential cycle to reject: `recovery -> envelope -> recovery` if the leaf imports its type/limits from the original file. Move those definitions down instead. The actual dependency is `recovery -> envelope -> encrypted-payload -> parser`; parser must not import recovery. Retain L1's old parser boundary. Lane 011 reported no static/type/literal-dynamic cycle; implementation must rewalk this reachable chain, including types, and preserve core-Lab exclusion. Functional codec coupling and unchanged sequential admission -> cache -> request -> injection; no new common mutable state.

## Tests

Direct importers, from `rg -l 'responses/agent-task-recovery["\x27]' tests | sort`, all **unchanged**:

```text
tests/routing/subagent-fallback-handle-responses.test.ts
tests/server/agent-task-recovery-combo.test.ts
tests/server/agent-task-recovery-fallback.test.ts
tests/server/agent-task-recovery-security.test.ts
tests/server/agent-task-recovery.test.ts
```

These imports exercise the public reset; actual recovery behavior is reached through server/core. Keep that integration path, not a weaker test-only export of internals. `tests/server/agent-task-recovery-cache.test.ts` imports the existing cache, not this file: run it unchanged as adjacent lifetime coverage. Helper `tests/helpers/agent-task-recovery.ts` is not a direct production-module importer and is not counted as one.

Literal/segmented path and source-reader searches found no direct source-text oracle for this file, agreeing with lane 011. Transitive graph oracles still read it and its new leaf:

| test and exact read | disposition | action |
|---|---|---|
| `tests/lab/core-lab-boundary.test.ts:69` | unchanged | Existing graph root core discovers the new envelope edge; PROTECTED roots untouched. |
| `tests/codex-integration/compatibility-manifest.test.ts:61` | unchanged | New leaf discovered through existing runtime-import traversal. |

No retarget-to-leaf or add-leaf-to-scan-list required. C-phase guards to drive red once: temporarily disable both multiplicity checks moved from original lines 136–137 (`encryptedPartCount !== 1`, `ciphertextCount !== 1`); the duplicate-encrypted-part case at `tests/server/agent-task-recovery-security.test.ts:279` must reject the mutation. Restore both checks, then green. Keep cached-admission test at line 99 and real success case in `tests/server/agent-task-recovery.test.ts:149` green, proving the split neither bypasses admission nor denies everything. Temporarily add each graph guard's forbidden edge in the new reachable leaf, get red, restore, get green. No test file is newly introduced.

## Verification

Future implementation commands only; no test or scan execution in this docs task:

```sh
bun run typecheck
bun test tests/server/agent-task-recovery.test.ts tests/server/agent-task-recovery-security.test.ts tests/server/agent-task-recovery-fallback.test.ts tests/server/agent-task-recovery-combo.test.ts tests/server/agent-task-recovery-cache.test.ts tests/routing/subagent-fallback-handle-responses.test.ts tests/codex-integration/compatibility-manifest.test.ts
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/server/responses/agent-task-envelope.ts src/server/responses/agent-task-recovery.ts
rg -n 'from "[^"]*/agent-task-recovery"' src gui/src scripts tests | wc -l
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-server-responses-agent-task-recovery && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Domains: server, routing, reachable-boundary codex-integration/Lab. Importer count remains 6; typecheck validates unchanged API resolution. Compare moved AST bodies allowing only leaf export modifiers and dependency wiring. Rewalk static/type/literal-dynamic edges for return paths and preserve PROTECTED roots. Record explicit security review per MAINTAINERS.md, since this is an existing security-sensitive boundary even though behavior does not change. Remote full suite only, tested SHA = PR head, exit 0 and 0 failures with full output retained; tail alone is insufficient. Exact-head CI rollup required.

## Accept criteria

1. All 31 owned declarations accounted for exactly once; the five public exports and caller paths remain unchanged.
2. Envelope leaf <=400 (146 planned), residual <=400 (356 planned); no #b and no cache duplication.
3. Exactly one originator Set, issuer Set and process HMAC key remain in original owner; one routing regex lives with all its consumers in the leaf.
4. Endpoint, header allowlist, admission-before-cache ordering, byte limits, assignment exactness, abort and reset semantics are unchanged; moved declarations compare mechanically.
5. Listed tests remain intact; mutation guard fails then passes after restoration; no reachable Lab edge or newly introduced cycle.
6. Typecheck, focused tests, privacy scan, remote exact-head full suite, exact-head CI and explicit security review are recorded before PR readiness.

## PR

Title: `refactor(server-responses): isolate agent task envelope codec (split S07 L3/4)`

Branch: `codex/split-server-responses-agent-task-recovery`. Base: `dev`. Closes: none. Fill Summary, Verification and Checklist from `.github/PULL_REQUEST_TEMPLATE.md`. Review this layer's diff only.

| # | PR | Layer / branch | Base | Review focus |
|---|---|---|---|---|
| 4 | #TBD-S07-L4 | codex/split-server-responses-collaboration | codex/split-responses-parser | Tool maps, roster rendering, insertion |
| 3 | #TBD-S07-L3 | codex/split-server-responses-agent-task-recovery — this layer | dev | Envelope codec ownership |
| 2 | #TBD-S07-L2 | codex/split-responses-namespace-tool-compat | dev | Restoration and alias contract |
| 1 | #TBD-S07-L1 | codex/split-responses-parser | dev | Private parser leaves; size escalation |

Base: dev — no dependency on the layers below; no cascade obligation.

Merge requires separate user authorization. This delegated task performs no Git or PR mutation.
