# Phase 3: include the injection-effort selector

## Source of truth and product fit

- Design record: `devlog/260710_injection_effort/000_design.md`
- Surface: existing opencodex developer Dashboard, global i18n, dense utility form
- UX direction: reuse the existing `Select` primitive and delegation panel; add no new design tokens, assets, cards, motion, dependencies, or page structure
- User outcome: configure both the preferred sub-agent model and the `reasoning_effort` passed to `spawn_agent`

## Diff-level inclusion map

- MODIFY `src/types.ts`: add optional `OcxConfig.injectionEffort`.
- MODIFY `src/reasoning-effort.ts`: export membership validation for the existing Codex effort ladder.
- MODIFY `src/server/management-api.ts`: GET returns current effort plus allowed efforts; PUT validates model/effort before mutating config, supports clear/unchanged semantics, and clears effort with model.
- MODIFY `src/server/responses.ts`: inject `reasoning_effort` guidance only when both an injection model and effort are configured; preserve the original max/ultra gate without a model.
- MODIFY `gui/src/pages/Dashboard.tsx`: load effort metadata, show a second existing-style selector only when a model is active, disable both controls while saving, and update local state only after a successful response.
- MODIFY `gui/src/i18n/en.ts`, `ko.ts`, `zh.ts`: add label and model-default copy in every shipped locale.
- MODIFY `tests/multi-agent-compat.test.ts`: cover model+effort prompt text, unset effort, and effort-without-model gate behavior.
- NEW `tests/injection-model-api.test.ts`: cover GET/PUT roundtrip, validation atomicity, effort clear, model clear, and absent-effort compatibility.
- INCLUDE `devlog/260710_injection_effort/000_design.md`: durable design and prior verification record.

## Contract and failure-state checks

- Invalid effort must return 400 without changing either the stored model or effort in memory or on disk.
- Missing `effort` in PUT preserves the existing effort while the model remains set, keeping older GUI clients compatible.
- Clearing the model clears effort; clearing effort alone preserves model.
- A failed Dashboard save leaves the last server-confirmed selection visible; controls remain keyboard-operable and carry accessible labels through the existing `Select` primitive.

## Verification

```bash
bun test tests/injection-model-api.test.ts tests/multi-agent-compat.test.ts
bun run typecheck
bun test tests
cd gui && bun run build
```

Rendered verification uses the existing GUI server and native browser tooling at 1440px, 1024px, 768px, and 390px. Inspect the delegation panel with no model, a selected model, model-default effort, and a concrete effort. Confirm no overlap/clipping in English, Korean, or Chinese labels and confirm model clearing hides the effort selector.

## Done criteria

- API and prompt contracts pass focused and full tests.
- GUI build succeeds.
- One clean rendered observation covers desktop/tablet/mobile layout and the conditional selector state.
- An independent reviewer finds no unresolved High/Critical issue in the combined release diff.
