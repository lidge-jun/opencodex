# Task 4 report: user documentation and architecture source of truth

## Scope

Updated only the requested English public documentation and architecture source of truth:

- `docs-site/src/content/docs/guides/sub-agent-surface.md`
- `docs-site/src/content/docs/reference/configuration/agents.md`
- `docs-site/src/content/docs/reference/management-api.md`
- `docs-site/src/content/docs/guides/web-dashboard.md`
- `structure/05_gui-and-management-api.md`

No runtime, GUI, configuration, test, generated-output, or translation files were changed. Existing
translated pages do not describe this new experiment, so none directly contradicts the English source.

## Documented behavior

The pages now distinguish:

- `keepNativeChatGptOnV1`: preserves a ChatGPT-native parent while moving its catalog entry to V1;
- `agentTaskRecovery`: preserves the native V2 parent and consumes an additional authenticated
  ChatGPT request/quota to recover encrypted routed-child content; and
- `v2NativeParentOverride`: preserves the V2 surface but executes an eligible native root on one
  configured routed provider before encrypted child content is created.

The docs include the exact persisted shape
`v2NativeParentOverride?: { enabled?: boolean; model?: string }`, the nested management GET DTO
`{ enabled, model, active }`, and the complete PUT shape
`{ v2NativeParentOverride: { enabled: boolean, model: string | null } }`.

They also state default-off and explicit-V2/upstream-flag requirements; the Keep ChatGPT on V1
conflict; noncanonical-provider validation; per-request target lookup; fail-closed behavior for
missing, disabled, unroutable, or canonical targets; provider exposure of prompts, repository
context, history, and tool results; requested-versus-effective model visibility/log identity; and
provider behavior, context, latency, cost, availability, and privacy trade-offs. The native-child /
routed-grandchild limitation is explicit. The docs do not claim automatic selection, fallback,
protocol decryption, nested override, CLI support, or per-thread pinning.

## Source/code cross-checks

- `src/types/config.ts:452-465` confirms the three separate settings and the optional persisted
  override shape.
- `src/server/management/agent-settings-routes.ts:93-107,280-302` confirms the GET DTO and
  derived `active` conditions; `:379-434` confirms complete-object validation, noncanonical target
  validation, explicit V2/upstream/Keep-V1 gates, atomic validation before writes, and the
  catalog-restamp-free override-only path.
- `src/server/responses/v2-native-parent-override.ts:13-54` confirms V2 eligibility, child/helper/
  combo exclusions, source-provider identity checks, per-request normal route lookup, and fail-closed
  target handling.
- `gui/src/components/subagents-workspace/SubagentDelegationSection.tsx:68-69,189-218` confirms
  the existing catalog is reused, canonical ChatGPT rows are filtered, and the switch/select expose
  the documented inactive and accessibility behavior.
- `docs/superpowers/specs/2026-08-24-v2-native-parent-override-design.md` confirms the requested
  model/effective routed model distinction, data exposure, trade-offs, no-fallback policy, and
  native-child limitation.

## Verification

Required docs checks completed in `docs-site/`:

```text
$ bun install --frozen-lockfile
bun install v1.3.14
368 packages installed [618.00ms]

$ bun run build
16:56:52 [build] 401 page(s) built in 10.93s
16:56:52 [build] Complete!
```

The build emitted the existing Vite warning about chunks larger than 500 kB; it did not fail.
`git diff --check` also passed.

## Self-review and concerns

The patch stays documentation-only and links the public guide to the configuration and API
canonical explanations instead of duplicating full policy. It deliberately leaves translations
unchanged because they have no contradictory claims. The only concern is the pre-existing Vite
chunk-size warning during the successful docs build; it is unrelated to this prose change.

Commit: included with this report and the documentation patch.

## Fix round 1

Reviewed the post-review runtime gate in `src/server/responses/v2-native-parent-override.ts`:
execution now requires the persisted enabled target plus explicit `multiAgentMode: "v2"`, the
upstream V2 flag, and `keepNativeChatGptOnV1 !== true`. Updated all five pages so execution is
described as occurring only while `active` is true. Each affected explanation now states that
changing mode, the upstream flag, or Keep ChatGPT on v1 makes subsequent requests skip the
override while preserving the stored target/enabled selection for later reactivation.

Verification:

```text
$ cd docs-site && bun install --frozen-lockfile
Checked 368 installs across 471 packages (no changes) [64.00ms]

$ bun run build
17:24:48 [build] 401 page(s) built in 4.36s
17:24:48 [build] Complete!

$ git diff --check
passed
```

The existing Vite chunk-size warning remains non-fatal and unrelated.
