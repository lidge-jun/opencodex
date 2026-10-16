# Phase 5 — #4213 trial prompt: account-scoped model availability NUX

Previous D (wp2): #5497 carry is PR #6112 at `95c59fc8da` (focused 261/261, sol review PASS); merge waits on exact-head CI alongside #6097. Direction change with reason: #4213 was planned as diagnosis only (`030_issues.md`). A sol explorer traced a concrete, fixable proxy-side cause for the trial-prompt half, so this phase fixes it, and `wp3` keeps only the comment follow-up.

## Cause

The public Codex client shows a model availability prompt only when a model row carries `availability_nux: { message }` (`openai/codex` `18344a972`: `codex-rs/tui/src/app/startup_prompts.rs:250-266`; type `codex-rs/protocol/src/openai_models.rs:222-224,277`). Behind OpenCodex, Codex reads the catalog written to `model_catalog_json`. OpenCodex fetches each account's live ChatGPT roster, but `parseAccountModels` (`src/codex/model-entitlements.ts:641-667`) keeps only slugs and `available_access_programs`, and native rows come from the pinned template where `availability_nux` is `null` (`src/codex/data/upstream-models.json:71`). An account-specific "try this model" prompt therefore cannot reach the app while OpenCodex owns the catalog. The Desktop trial UI source is not public, so this is the strongest verified candidate, not a captured trace.

## Change map

| Path | Action | Before → after |
| --- | --- | --- |
| `src/codex/model-entitlements.ts` | MODIFY | `parseAccountModels` also returns `availabilityNuxByModel`: only rows it already keeps, only a plain object whose `message` is a non-empty string after trim, capped at 2,000 characters, stored as `{ message }` (no other fields). `CachedAccountModels` carries it; `CodexModelEntitlementSnapshot` gains optional `availabilityNuxByAccount`, populated only for confirmed rosters, mirroring `accessProgramsByAccount`. |
| `src/codex/catalog/access-programs.ts` | MODIFY | `applyNativeAccessPrograms` additionally projects the NUX onto **bare native rows of the main account only**, when that roster is confirmed and lists the slug: set `availability_nux` to the live `{ message }`, otherwise `null`. Combo rows, native alias rows and account-bound (selector) rows get `availability_nux` removed, so a Pool account's prompt never shows and one account's prompt is never duplicated. Routed/derived/Reserve stripping elsewhere stays untouched. |
| `tests/codex-integration/codex-native-availability-nux.test.ts` | NEW | Fixture roster through `resolveCodexModelEntitlements` with a fake fetcher (main row with NUX, Pool row with a different NUX, malformed shapes) and the projection over catalog rows. Register in both layout registries. |
| `structure/catalog.md` (or the owner that documents access-program projection) | MODIFY | Document the NUX projection next to the access-program projection. |
| `docs-site/src/content/docs/guides/codex-integration.md` | MODIFY | One sentence: OpenCodex forwards the main account's live model availability prompt on native rows. |

The online `GET /v1/models?client_version=` fallback does not project access programs today (`src/server/index/serve-options.ts:1071-1110`); it stays unchanged here, and the plan records that parity gap.

## Activation and observable checks

1. Main account's confirmed roster lists `gpt-6-astra` with `availability_nux: { message: "M" }` → bare native `gpt-6-astra` row carries exactly `{ message: "M" }`.
2. Same roster without the field, or with `null`, and a stale on-disk row carrying an old NUX → row ends with `null`.
3. Unconfirmed main roster (fetch failure) → `null`; never an old value.
4. A Pool account's roster carries a NUX for the same slug → no bare row and no account-bound row shows it.
5. Malformed NUX (string, array, missing/empty/non-string message, extra fields) → dropped or reduced to `{ message }`; roster confirmation and access programs unaffected.
6. Combo and native alias rows claiming the slug → no `availability_nux`.

## Verification

`bun test` on the new file plus `codex-forward-access-programs-writer`, `codex-model-entitlements-program-shape`, `codex-convergence-account-selectors`, `reserve-catalog`, `gpt6-native-rows`, layout and ratchet guards; `bun run typecheck`, `structure:check`, `privacy:scan`, `git diff --check`, docs-site build; `test:changed` in the `/private/tmp` checkout. Red-green on the new file. Independent review. Separate PR against `dev`, linked from #4213; the issue stays open until a user confirms the prompt on a current build.

## Audit amendment (sol reviewer, NEAR-PASS)

The account boundary, both writer call sites and the later catalog steps were confirmed. One blocker folded in: the new test also drives **both on-disk writers** (retained sync and convergence, following the pattern in `tests/codex-integration/codex-convergence-account-selectors.test.ts:343`) and asserts the *written catalog* for the main-account NUX, its removal on a later roster without it, Pool isolation, and alias/selector cleanup. Recorded limitations: the bare row follows the account in the Codex home OpenCodex manages, which is the App's login only when the App uses that home; convergence already republishes the catalog even when unchanged (`src/codex/convergence.ts:614`), which predates this change. `tests/codex-integration/codex-catalog.test.ts` sits 11 lines under its cap and is not touched.
