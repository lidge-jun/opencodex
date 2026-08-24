# Experimental V2 Native Parent Override Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-24-v2-native-parent-override-design.md`

## Global Constraints

- Work on `codex/v2-native-parent-override`, based on `origin/main`.
- The feature is experimental, default-off, explicit-V2-only, and independent of `keepNativeChatGptOnV1` and `agentTaskRecovery`.
- Use existing routing, configuration, management API, GUI model-catalog, i18n, and compaction patterns; add no dependency, CLI command, automatic model selection, per-thread state, nested-child rewrite, or protocol decryption.
- Once an eligible canonical ChatGPT V2 root is identified, missing, unroutable, disabled, or canonical targets fail closed and never fall back to ChatGPT.
- Preserve existing request logging privacy: the original request model remains `logCtx.requestedModel`; do not add request bodies, prompts, account identifiers, credentials, or a new override-source field to logs.
- Keep `src/router.ts`, `src/server/lifecycle.ts`, and `src/server/responses/core.ts` free of direct or transitive `src/lab/` imports.
- Follow TDD for every behavior change: capture RED and GREEN commands/output in the task report.

## Task 1: Configuration, provider migration, and management API

Add the persisted contract and authenticated `/api/v2` management surface.

- Add `v2NativeParentOverride?: { enabled?: boolean; model?: string }` near the existing multi-agent settings in `src/types/config.ts` and its strict optional schema in `src/config.ts`.
- Treat a present model as trimmed and nonblank. A malformed hand-edited subtree must be dropped/disabled without invalidating unrelated config; invalid programmatic writes must fail validation.
- Extend existing provider-id/model-reference rewrite paths so provider renames and legacy OpenAI-provider migrations rewrite the selected target.
- Extend `GET /api/v2` with `{ enabled, model, active }`, where `active` is true only when enabled, the model is present, `multiAgentMode === "v2"`, the upstream V2 feature is enabled, and `keepNativeChatGptOnV1 !== true`.
- Extend `PUT /api/v2` to accept a complete `{ enabled: boolean, model: string | null }` object. Validate the whole request before writes. A non-null model must resolve through `routeModel` to a noncanonical configured provider. Enabling requires a model, explicit V2 mode, the upstream V2 flag, and no keep-native-V1 conflict.
- Persist only this subtree, preserve the selected target when disabled, preserve all unrelated settings, perform no catalog restamp/convergence for an override-only write, and re-use the existing `/api/v2` response/read flow.
- Add focused tests for config round-trip/isolation, invalid shapes, provider rewrite, GET defaults/active state, atomic PUT success/failure, preservation of disabled targets, and unrelated settings.

Focused verification:

```bash
bun test tests/config.test.ts tests/provider-id-rewrite.test.ts tests/multi-agent-keep-native-v1.test.ts
bun run typecheck
```

## Task 2: Ordinary Responses and compact runtime routing

Implement the guarded request-time route replacement with one small shared decision helper under `src/server/responses/`, reused by `core.ts` and `compact.ts`.

- The helper returns skip, reject, or the configured target. It must require the feature enabled and the already-resolved source provider to be canonical ChatGPT; reject combo attempts, exact spawned children, and every other `x-openai-subagent` helper marker.
- Ordinary Responses eligibility requires `collabSurface(parsed) === "v2"`, or `_compactionRequest === true` while `multiAgentMode === "v2"`. Run it after parsing, shadow interception, and initial route resolution but before child fallback/authentication.
- Resolve the target through normal routing and require a noncanonical provider. Only after success replace the route and rewrite both `parsed.modelId` and `parsed._rawBody.model`. Preserve the caller model in `logCtx.requestedModel`.
- `/responses/compact` eligibility requires explicit `multiAgentMode === "v2"` and no child/helper marker. Apply it after original route resolution and before native-versus-synthetic compaction selection so routed roots use existing synthetic compaction and native children remain native.
- Once eligibility is established, missing/unroutable/canonical targets return the existing invalid-route error representation without native upstream I/O. Out-of-scope requests retain existing behavior.
- Add `tests/responses-v2-native-parent-override.test.ts` and extend compact routing tests for native root override, dual model rewrite, logging identity, routed/V1/non-agent/combo/malformed/child/helper exclusions, fail-closed targets, routed root synthetic compaction, native child compaction, shadow ordering, and recovery ordering.

Focused verification:

```bash
bun test tests/responses-v2-native-parent-override.test.ts tests/responses-compaction-routing.test.ts tests/responses-shadow-intercept.test.ts tests/agent-task-recovery.test.ts
bun test tests/core-lab-boundary.test.ts
bun run typecheck
```

## Task 3: Dashboard controls and localization

Add the experiment to Subagents → Settings near the existing V2/Ultra controls using existing components and data flows.

- Reuse the loaded delegation-model catalog and current select/switch styling; exclude canonical ChatGPT rows without adding a bespoke picker or dependency.
- Load `{ enabled, model, active }` from `/api/v2`. Permit selection while disabled. Every select or switch mutation sends the complete `{ enabled, model }` object atomically, then re-reads `/api/v2`; server state wins over optimistic state.
- Disable activation and show guidance unless explicit V2 is active, the upstream flag is enabled, and keep-native-V1 is off. Surface API failures through the existing notice mechanism.
- Preserve accessibility with semantic labels, keyboard operation, and `aria-pressed`.
- Explain that Codex may display the original native model while OpenCodex executes the root on the routed target. Warn that prompts, repository context, conversation history, and tool results go to the selected provider and inherit its availability, context, latency, behavior, cost, and privacy characteristics.
- Add all visible copy to `en.ts` and every existing locale module.
- Extend the existing Subagents focused test for default-off hydration, model filtering, disabled selection persistence, atomic enable, failed-update rollback, post-save refresh precedence, accessibility, and conflict/inactive states.

Focused verification:

```bash
cd gui
bun test tests/subagents-ultra-mode.test.tsx
bun run lint:i18n
bun run lint
bun run build
```

## Task 4: User documentation and architecture source of truth

Document the shipped experiment without duplicating policy unnecessarily.

- Update the sub-agent surface guide, agent configuration reference, management API reference, dashboard guide, and `structure/05_gui-and-management-api.md`.
- Distinguish V1 native-parent preservation, ChatGPT-quota-consuming V2 task recovery, and V2 native-parent override.
- Document explicit V2/default-off requirements, fail-closed behavior, provider data exposure, per-request target lookup, UI requested-model mismatch, provider behavior/cost/context trade-offs, and the native-child/routed-grandchild limitation.
- Do not claim automatic selection, fallback, nested override, protocol decryption, CLI support, or per-thread target pinning.

Focused verification:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## Final verification

```bash
bun test tests/config.test.ts tests/provider-id-rewrite.test.ts
bun test tests/multi-agent-keep-native-v1.test.ts
bun test tests/responses-v2-native-parent-override.test.ts
bun test tests/responses-compaction-routing.test.ts
bun test tests/core-lab-boundary.test.ts
bun run typecheck
bun run test
bun run privacy:scan
cd gui && bun test tests/subagents-ultra-mode.test.tsx && bun run lint:i18n && bun run lint && bun run build
cd ../docs-site && bun install --frozen-lockfile && bun run build
```
