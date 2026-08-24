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
