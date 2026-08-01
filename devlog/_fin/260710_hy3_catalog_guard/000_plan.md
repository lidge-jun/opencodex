# Issue #82 HY3 Catalog Guard — Unit Plan

## Loop specification

- **Loop archetype:** finite defect correction, one work-phase.
- **Trigger:** GitHub issue #82 reports that `opencode-go/hy3-preview` is selectable but
  Console Go rejects it with `model_not_supported`; on 2026-07-10 the public Zen Go
  `/models` response still advertises the rejected id.
- **Goal:** Codex, the dashboard, and all catalog consumers stop offering the exact
  `opencode-go/hy3-preview` pair while other OpenCode Go live models continue to flow
  through without a frozen allowlist.
- **Non-goals:** changing the OpenCode Go base URL, mirroring the provider's private
  `/inference/...` route, blocking `hy3-preview` under unrelated providers, changing
  direct request routing, or maintaining a complete static OpenCode Go allowlist.
- **Verifier:** a mocked live-discovery regression must drive the advertised HY3 row
  through `gatherRoutedModels` and observe its exclusion while a future model and an
  unrelated provider's same id survive; affected catalog tests, TypeScript typecheck,
  and the full Bun suite must pass.
- **Stop condition:** the exact unavailable provider/model pair is absent from every
  gathered routed catalog, sibling live rows remain present, the source-of-truth doc is
  synchronized, independent review passes, the fix is published, and issue #82 is
  corrected and closed as completed.
- **Memory artifact:** this implementation unit, archived from
  `devlog/_plan/260710_hy3_catalog_guard/` to `devlog/_fin/260710_hy3_catalog_guard/`
  with command outputs and GitHub closure evidence.
- **Expected terminal outcomes:** completed with the narrow guard; or escalated if the
  public Zen Go catalog stops advertising HY3 and authenticated evidence proves Console
  Go accepts it consistently before publication.
- **Escalation condition:** the fix would need endpoint migration, authentication-policy
  changes, or a broad provider allowlist rather than the exact catalog exclusion.

## Classification and scope

- **Work class:** C4. The code delta is narrow, but routed model availability is a
  user-visible `/v1/models` and Codex-picker contract.
- **IN:** final routed-model exposure policy, regression coverage for the live `/models`
  path, `structure/03_catalog-and-subagents.md` synchronization, GitHub issue correction.
- **OUT:** adapters, request bodies, authentication, provider endpoint resolution,
  generated jawcode metadata, unrelated dirty workflow/test changes.
- **Existing work preservation:** the worktree already contains user edits in
  `src/codex/catalog.ts`, `tests/codex-catalog.test.ts`, workflow files, and Kiro tests.
  This unit adds isolated hunks and stages only its own files/hunks.

## Structural decision

- **Context:** live discovery and jawcode augmentation converge in
  `gatherRoutedModels`; the final `shouldExposeRoutedModel` pass already owns exclusions
  that must not reach dashboard or catalog consumers.
- **Rejected alternative:** `selectedModels` or `liveModels: false` would freeze today's
  lineup and suppress future valid models. Removing generated metadata alone is already
  insufficient because the public live endpoint re-advertises HY3. A new persisted
  provider-config field would spread a one-pair compatibility exception through types,
  registry derivation, and hydration without adding a real second consumer.
- **Chosen move:** keep an exact namespaced compatibility exclusion in
  `src/codex/catalog.ts` and apply it in the existing final exposure predicate after all
  live/static/metadata sources have converged.
- **Consequences:** no new module dependency or public configuration field; the admin
  model list and Codex catalog both stop presenting an unusable row. Manual direct
  routing remains unchanged and will still report the provider's own error if invoked.
- **Coupling classification:** low functional coupling inside the catalog module; no
  new cross-module import, public export, or cycle.

## Work-phase map

| WP | Document | Dependency-ordered outcome |
| --- | --- | --- |
| 1 | `010_catalog_exposure_guard.md` | Add red live-discovery coverage, implement the final exact-pair guard, synchronize the catalog SOT, verify, publish, and close #82. |

## Source-of-truth and rollback

- Current architecture SOT: `structure/03_catalog-and-subagents.md`.
- C updates its shared-catalog policy list to state that provider/model compatibility
  exclusions are applied after discovery and augmentation.
- Rollback is one exact set entry plus its tests/doc sentence. The guard is removable
  when authenticated upstream evidence proves the model is actually callable again.

