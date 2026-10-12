# Phase 040 — auth, config, account and issue disposition

## PR decisions

- **#4649 and #4644 — defer:** The draft changes credential persistence and has not passed the explicit security review required by `MAINTAINERS.md`. Keep the PR and issue open; the current screenshot file also violates repository hygiene. The security analysis and any pre-disclosure repair plan stay in ignored `.tmp/gui-ux/4649-security-review.md`, not this public devlog. This workaround cannot be called Safari AutoFill itself. A later adoption is a new scoped phase after security and real iOS standalone proof.
- **#5932 — defer from this lane:** its `ProviderAuthPanel.tsx`, `useProviderAccountPools.ts`, provider workspace types, and OAuth account DTO overlap the account-pool lane. Do not touch those files here. The account-pool lane should determine whether a plan badge is still missing after its work; leave PR open with an ownership and current-conflict comment.
- **#2355 — defer this old branch; consider a new scoped issue later:** eight conflicts across `src/config.ts`, server lifecycle, CLI and dashboard. A safe version would require a resident-vs-disk config identity, low-privilege status read, warning/retry UI and tests for managed save versus external edit. Its `docs/pr-assets/` screenshot cannot be carried. The config/picker lanes may move those owners during this train; leave the PR open with current file evidence.
- **#5408 — defer wholesale:** 7,790 insertions across 67 files, six current conflicts and account-pool overlap. Do no cherry-pick until individual behavior gaps are identified in the current provider workspace; this lane performs suitability judgment only. Leave a concrete English comment and keep it open.

## Issue decisions

- **#3379 — hold open:** journal deletion and custom Usage ranges already landed, but the remaining Codex selector rename is absent. `gui/src/components/CodexAccountPickerSetting.tsx` only toggles picker visibility; `src/server/management/config-routes.ts` has no selector-name edit API. Generic OAuth `alias` is a different field. This touches picker/account ownership, so record the gap and avoid a duplicate implementation in this GUI lane.
- **#4189:** current ZCode client integration and Z.AI provider APIs are separate. The report does not identify a ZCode upstream login/API contract. Ask the issue author in English whether they mean the ZCode client using OpenCodex, Z.AI API-key upstream, or a distinct login; leave open pending answer and do not add a fake `zcode` provider card.

For every deferred PR or issue, post one evidence-backed English comment with the disposition. Do not close a contributor PR merely for being large or stale. An adopted contributor PR closes only after a replacement lands and a credit trailer plus replacement link are present.

## Final dispositions (2026-09-28)

The coordinator ended train 4's implementation work early and told the lane to leave hold comments on unstarted candidates. Every comment below is in English with file-level reasons, and every PR and issue stays open.

| Item | Outcome | Reason |
|---|---|---|
| #6058 | Carried, merged in #6105 (`3401e1ee73`), closed with credit | See `010`–`012`. |
| #4932 | Held for the next train | The plan passed audit with fixes, but implementation had not started when the scope narrowed. The plan and audit are in `020_combo_sidecar.md`. |
| #5617 | Held | There is no migration or rollback between `globalDisabledModelIds` and `disabledModels`. It conflicts in `app-routing.ts`, `Providers.tsx` and `structure/config.md`, overlaps #6106, and has four open CodeRabbit findings. |
| #4649 | Held | It needs a credential-handling security review. A remembered token survives logout, the tests target the old `/api/settings` path, the docs would become false, a screenshot is committed, and the branch is 317 commits behind. |
| #5932 | Held | Every file belongs to the account-pool work (#6106), and `provider-workspace/types.ts` conflicts. |
| #2355 | Held | 2,971 commits behind with eight conflicting files, and screenshots are committed under `docs/pr-assets/`. |
| #5408 | Held | 67 files and 7,790 added lines, six conflicts, overlap with #6106, and eleven committed screenshots. It should be split into single-behavior PRs. |
| #4644 | Open | #4649 is held. |
| #3379 | Open | Journal deletion and custom ranges have landed; renaming the selector (picker/account area) remains. |
| #4189 | Open, question asked | ZCode (client) versus Z.AI (`zai` key provider) versus draft #4259/#4647. It belongs to the provider area. |
