# Grok Responses default and Chat opt-in

- Loop archetype: spec-satisfaction, one product slice / one PABCD cycle.
- Trigger: owner request to restore Responses, expose Chat through GUI and CLI, open a PR and admin-merge it.
- Goal: Grok 4.5/4.6 OAuth Responses callers use native Responses; existing Chat overrides are removed once on upgrade per owner steering, and subsequent operator choices remain authoritative.
- Non-goals: API-key default changes, other inbound defaults, other Grok models, tier policy, new endpoints, credential changes, release/deploy or restarting the live dogfood service.
- Class: C4 because owner steering requires a one-time persisted configuration migration.
- Verifier: exact-head GitHub CI (typecheck, runtime and GUI tests, GUI build, privacy and docs checks), isolated GUI interaction and CLI invocation. No local test suites or typecheck; pushes use `git push --no-verify`.
- Stop condition: acceptance below plus PR merged into dev with fetched ancestry proof.
- Memory artifact: this unit and numbered implementation/check record, all in the bound worktree.
- Expected terminal outcomes: DONE, or NEEDS_HUMAN if authority/external access prevents completion. CI failure is work to diagnose, not permission to weaken the gate.
- Escalation: no unrelated changes or live account/service mutations. Main owns implementation; independent read-only reviewer checks plan and diff. Reclaim failed review after two distinct failed dispatches.

## Current evidence and reuse

Baseline `c4701938c`: clean detached app worktree, equal to fetched origin/dev; adopted in place as `codex/grok-responses-default-chat-optin`.
`src/providers/registry.ts:1263` owns exact-model, OAuth/Responses-scoped defaults. `src/server/adapter-resolve.ts:23` already gives explicit modelAdapters precedence. `src/providers/xai-responses-opt-in.ts:8` currently reports stored entries rather than effective wire. `src/server/management/provider-routes.ts:392` owns the atomic switch patch. `src/cli/provider-runtime.ts:55` already sends provider edits to that endpoint. `gui/src/components/provider-workspace/ProviderAuthPanel.tsx:40` already owns a pending/error/mixed-state switch.

No-code alternatives: doing nothing does not flip the shipped default; per-user configuration would not implement the product request; deleting Chat support removes the required rollback. Reuse existing registry defaults, modelAdapters, provider edit, and GUI switch. Do not introduce a second persisted preference or a second route.

## Acceptance

1. Unconfigured OAuth Grok 4.5/4.6 Responses requests resolve to Responses. Startup removes old Chat overrides once for this same built-in xai OAuth scope. A persisted per-provider version prevents reapplying the upgrade over subsequent Chat opt-in. Custom provider IDs, key auth, translated Chat/Anthropic defaults and other Grok models remain unchanged; removal of an old explicit per-model override also restores those inbounds to their own defaults. The reserved xai OAuth provider is name-pinned to the Grok CLI destination regardless of saved baseUrl (`src/providers/xai-transport.ts:170`); it is not a custom transport.
2. API/DTO state follows effective Responses-inbound routing: no entries means true on the canonical OAuth preset; explicit Chat for one means mixed; both Chat means false. Explicit Responses on just one is not mixed when the other already defaults to Responses.
3. Existing `xaiResponsesOptIn` boolean API remains compatible in visible intent: true selects Responses, false selects Chat explicitly. Both update only the two owned entries; malformed/non-xAI writes still fail.
4. GUI shows Chat Completions selection. Off means both Responses; on means both Chat; mixed click selects Chat for both. Pending/error and authoritative server echo remain intact. All locale copy agrees.
5. `ocx provider edit xai --xai-chat on|off [--json]` uses that same live API, validates input, and preserves unrelated configuration. Help and docs expose the option.
6. Existing sanitizer/replay, tier-isolation, transport, API, CLI, and component regressions run on CI; no tests are disabled. Screenshot is inspected and included in the templated PR. Admin bypass is disclosed, never self-approved.
7. Migration is idempotent and rebased on fresh disk state under the existing mutation lock. Read-only config APIs do not migrate. Failed persistence preserves disk bytes and reports an in-memory-only upgrade. Switch writes mark the migration complete so an intentional Chat selection survives restart even after startup persistence failed.

## Steering at A

Owner explicitly rejected preserving pre-upgrade Chat settings. Amend the single slice with a one-time migration; keep the previously declared canonical OAuth/Responses default scope. No changes to live user settings in this development task. A new provider marker is upgrade bookkeeping, not a parallel wire preference.

## Audit fold-back

Round 1 FAIL: (1) custom URL promise was imprecise, (2) POST overwrite could lose opt-in/marker, (3) switch could lower future version. Resolve (1) by documenting actual name-pinned OAuth transport, not inventing a new endpoint guard inconsistent with Fast authority; test custom provider IDs. Fold (2) into existing POST retention using the latest live row after DNS awaits; preserve omitted modelAdapters plus marker. Fold (3) by preserving the maximum of the existing version and 1. Runtime marker classification and real startup/restart coverage are also required.

## Verification execution

The requested no-local-suite restriction supersedes local preflight requirements. Read the repository workflow and scripts to confirm test target coverage; execute them on CI, not locally. `git diff --check` and help/isolated UI invocations are local non-suite checks. If remote CI does not cover an acceptance row, use an isolated remote checkout for a focused command.
