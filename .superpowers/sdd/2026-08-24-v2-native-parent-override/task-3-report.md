# Task 3 report: Dashboard controls and localization

## Status

DONE

## Implementation

- Added the V2 native parent override control to Subagents → Settings beside the existing Ultra controls.
- Hydrates `v2NativeParentOverride` from the existing `/api/v2` load and keeps the API's `active` state for inactive/conflict guidance.
- Reuses the loaded delegation catalog and filters canonical ChatGPT rows by the existing `provider` metadata (`provider !== "openai"`).
- Model selection remains available while the experiment is disabled. Every selection or switch action sends the complete nested `{ enabled, model }` payload, then reloads `/api/v2` so server state wins.
- Activation is disabled unless explicit V2 is enabled, the upstream flag is enabled, Keep ChatGPT on v1 is off, and a target model is selected. Deactivation remains available for recovery from an inactive/conflicting persisted state.
- Uses the shared `Select` and `Switch` primitives, including semantic labels, keyboard behavior, and `aria-pressed`.
- Added the execution-model and provider/privacy warning copy to English and all eight other existing locales.

## TDD evidence

### RED

Command:

```text
cd gui && bun test tests/subagents-ultra-mode.test.tsx
```

Before production changes, the four existing tests passed and the six new tests failed because the expected native parent controls were absent:

```text
4 pass
6 fail
Native parent switch not found
Native parent model select not found
```

The failures were expected and directly exercised missing hydration, selection, atomic writes, rollback, refresh precedence, accessibility, and gating behavior.

### GREEN

Command:

```text
cd gui && bun test tests/subagents-ultra-mode.test.tsx
```

After implementation and the additional inactive-state case:

```text
11 pass
0 fail
32 expect() calls
```

## Verification

- `cd gui && bun test tests/subagents-ultra-mode.test.tsx` — 11/11 passing.
- `cd gui && bun run lint:i18n` — passed.
- `cd gui && bun run lint` — passed.
- `cd gui && bun run build` — passed; Vite emitted only the existing chunk-size advisory.
- `cd gui && bun test tests/subagents-roles.test.tsx tests/locale-parity.test.ts` — 10/10 passing.
- `git diff --check` — passed.

## Files changed

- `gui/src/pages/Subagents.tsx`
- `gui/src/pages/use-subagent-delegation.ts`
- `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx`
- `gui/src/components/subagents-workspace/SubagentDelegationSection.tsx`
- `gui/src/i18n/en.ts`
- `gui/src/i18n/de.ts`
- `gui/src/i18n/fr.ts`
- `gui/src/i18n/ja.ts`
- `gui/src/i18n/ko.ts`
- `gui/src/i18n/ru.ts`
- `gui/src/i18n/tr.ts`
- `gui/src/i18n/zh.ts`
- `gui/src/i18n/zh-TW.ts`
- `gui/tests/subagents-ultra-mode.test.tsx`

## Self-review

- No runtime/config/API changes were needed; the established `/api/v2` contract was consumed as-is.
- No new dependency, picker, or abstraction was added.
- The control intentionally preserves the old selection after failed PUT/refresh, so failed changes roll back without optimistic state drift.
- The existing custom select supplies keyboard semantics; the new switch uses the shared semantic button primitive.

## Concerns

- `bun run build` reports the pre-existing Vite warning that the main JavaScript chunk exceeds 500 kB. It does not fail the build and is unrelated to this scoped change.

## Review fix round 1

### Changes

- Clearing the model now sends `{ enabled: false, model: null }`, preserving the server's complete-state contract and avoiding an invalid enabled-without-model request.
- Added a ref-backed in-flight guard in `Subagents.tsx`; the existing saving state continues to disable the controls after React commits, while the ref closes the same-render/stale-handler gap before a second PUT can start.
- Added regression coverage for persisted enabled/inactive conflicts, atomic clearing, and rapid mutation attempts.

### TDD evidence

RED command:

```text
cd gui && bun test tests/subagents-ultra-mode.test.tsx
```

Before the fix, 13 tests passed and the new clearing test failed with:

```text
Expected: { enabled: false, model: null }
Received: [{ enabled: true, model: null }]
```

The conflict and rapid-mutation tests were already green against the rendered pending-state behavior; the ref guard hardens the same contract for stale/same-render handlers.

GREEN command:

```text
cd gui && bun test tests/subagents-ultra-mode.test.tsx
```

After the fix: `14 pass`, `0 fail`, `38 expect() calls`.

## Review fix round 2

### Changes

- Corrected the rapid-mutation fixture to hydrate explicit V2, upstream enabled, Keep ChatGPT on v1 off, and a selected routed model, so both controls are actionable.
- The test now triggers model selection and activation in one same-render act before the pending state can commit.

### TDD evidence

GREEN before guard bypass:

```text
cd gui && bun test tests/subagents-ultra-mode.test.tsx
14 pass
0 fail
```

Temporary RED proof (uncommitted production-only mutation replaced the ref check with the old React-state check):

```text
cd gui && bun test tests/subagents-ultra-mode.test.tsx
13 pass
1 fail
Received: [{ enabled: false, model: "relay/second-model" }, { enabled: true, model: "relay/first-model" }]
```

The ref guard was restored immediately. Final GREEN:

```text
cd gui && bun test tests/subagents-ultra-mode.test.tsx
14 pass
0 fail
38 expect() calls
```

## Review fix round 3

### Changes

- Updated only `sub.nativeParentOverrideSaved` in English and every locale.
- The save toast now correctly says the choice applies to subsequent parent turns and compaction, rather than only new Codex sessions.
- No component or new translation key changes were needed; this copy-only correction needs no artificial unit test.

### Verification

- `cd gui && bun test tests/locale-parity.test.ts` — 3/3 passing.
- `cd gui && bun run lint:i18n` — passed.
- `cd gui && bun test tests/subagents-ultra-mode.test.tsx` — 14/14 passing.
- `cd gui && bun run lint` — passed.
- `cd gui && bun run build` — passed; Vite emitted only the existing chunk-size advisory.
- `git diff --check` — passed.
