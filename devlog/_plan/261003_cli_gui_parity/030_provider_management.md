# wp3 — Add exact live provider workflows and bounded structured input

Depends on wp2. Class C3 with C4 review for credential/destination/deletion boundaries. Layer 2. Keep server authority and offline defaults; GUI-equivalent live mutations are explicit.

## New shared input with its first consumer

NEW src/cli/json-input.ts: explicit path or '-' reader with a 4 MiB ceiling matching src/server/management/body.ts:9, bounded stdin deadline, EOF/error cleanup and no TTY wait. Use existing readSecretBytes for injected stdin or existing bounded-body stream utilities; payload labels/errors never include raw JSON or credentials. Decode UTF-8 strictly, allow normal UTF-8 BOM behavior, parse once, expose unknown to the domain shape validator. Duplicate/conflicting sources are rejected before reading. Composite body byte size is checked before sending. No endpoint/method selection comes from input data.

NEW tests/cli/cli-json-input.test.ts: empty/invalid/array/BOM/multiline input, exact cap and cap+1, stdin EOF/error/deadline/TTY refusal, cleanup and no value echo. This helper ships with provider snapshot/apply, not as an unused framework.

## Provider command contracts

| Command | Exact behavior |
| --- | --- |
| provider add P ... --live [--json] | Resolve runtime once; load target preset when needed; POST /api/providers {name,provider,setDefault?}. Add --responses-path and --auth-mode to domain parsing. Retain explicit --force overwrite intent and document existing upsert race; no invented atomic create-only guarantee. Reject --live --sync. |
| provider set-default P --live --json | Standalone PATCH /api/providers?name=P with {setDefault:true}; server rejects disabled/unknown rows. |
| provider remove P --live --yes --json | One DELETE /api/providers?name=P; disclose default reassignment and credential/custom-model cleanup. No local pre-write, emulated two-step deletion or fallback. |
| provider edit P --upstream-http-version http1.1\|- --fast on\|off --context-window N\|- | Extend existing PATCH with upstreamHttpVersion (null clear), fastEnabled and provider contextWindow. Existing flags/omission semantics preserved. Per-model context already exists; optional repeated model-context-window only if atomic GUI update needs it. |
| provider pacing P [--json] | GET provider-request-pacing?name=P, with meaningful no-rules state. |
| provider pacing P --file FILE [--json] | PATCH only {requestPacing:<validated complete rules>}; domain rules contain enabled and optional provider/model RPM/minIntervalMs/maxConcurrentRequests. Provide common scalar flags for provider-level fields; preserve untouched rules for partial flags using one pinned read. Setting enabled:false disables pacing; per-model rules use the explicit complete rules file, not a speculative clear flag. |
| provider snapshot --json | GET /api/config and project exactly GUI editor {defaultProvider,providers}, excluding hasApiKey/hasHeaders/xaiResponsesOptInState/initialModelSelection. No secret export. |
| provider apply --baseline FILE --file FILE --json | PUT /api/providers exactly {baseline,next}; validate DTO shape, no credential/derived fields; preserve stale-baseline 409 and never auto-refresh/rebase. Removal within batch requires --yes with explicit affected scope in help. |

MODIFY src/cli/provider.ts to route --live before local load/save, retain offline defaults and local removal refusal. Correct explicit local --sync --json: call existing syncModelsToCodex with quiet log parameter and report actual saved/synced/skipped/refused disposition; output mode must not cancel a requested effect. No false 'synced' message when stopped/failure. MODIFY provider-runtime.ts for extension dispatch only; NEW provider-lifecycle-runtime.ts, provider-settings.ts and provider-batch.ts own cohesive new behavior. RuntimeApiDeps is injectable; all multi-request workflows pin baseUrl once.

MODIFY runtime-api.ts only for safe nested error code/message projection needed by routing/provider responses, retaining exit mapping/prose stderr. Never dump arbitrary RuntimeApiError.body. Domain failed-convergence output retains safe saved/catalog receipt rather than claiming rollback or unconditional success.

Metadata: capabilities-provider-models.ts, registry usage and generated chapters. Structure: cli-management.md, config.md and existing provider destination contracts as affected; no provider adapter logic change. Public provider docs/skill recipes show snapshot/edit/apply/read-back and explicit live/offline distinction.

NEW tests/cli/cli-provider-lifecycle-runtime.test.ts, cli-provider-settings.test.ts, cli-provider-batch.test.ts. MODIFY the original local provider sync JSON test to the deliberately corrected contract; retain its no-live case. Existing tests/providers/provider-config-batch-management.test.ts supplies server CAS/validation truth.

## Acceptance

Assert exact named requests, pinned target, zero local mutation on live refusal, wrong/missing/duplicate argument rejection before write, scalar omission/null/false/0, target preset handling and stale CAS refusal. Live deletion uses server dependency/default handling. Saved-but-unapplied receipts and missing proxy are honest. Body failures and credential-shaped data never leak. Baseline offline provider behavior stays tested. Explicit security review covers auth headers, input buffers, destination validation reuse and delete scope.

## Shared completion contract

This phase follows 002_terminal_ux.md and 003_verification_strategy.md. Main owns registry/dispatch integration, layout-map registration, generated output and Git branch state; executor write scopes are disjoint and named before B. Existing method/path/body semantics come from the referenced source inventories, not endpoint-name guessing.

Update the phase's capability domain, generated references, relevant public CLI pages and owning structure contracts in the same layer. Every new test file enters scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json. Existing tests are retained; no baseline cap increases or green-on-retry acceptance.

Planned new test paths below become executable verification only after B creates them. The current baseline gates in 003 have actually run. C invokes the exact focused files, typecheck, structure and skill-surface checks, privacy where data is handled, a source-bound cxc receipt and real isolated CLI QA (stdout/stderr/exit/teardown). A successful function mock is transport proof only; relevant existing server tests or isolated real handlers verify accepted state. No live user proxy, credentials or upstream requests.

Before P>A, revalidate this document against the parent layer and record the prior D conclusion. Consult an architect for actual decision changes; independent A review is separate. C must preserve saved-versus-applied/refused outcomes. D records exact checks and ledger evidence before the next cycle. Publishing is main-owned; this request stops at open PRs.
