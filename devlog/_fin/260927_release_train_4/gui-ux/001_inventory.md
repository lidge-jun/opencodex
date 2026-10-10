# GUI UX lane — current intake evidence

Read at `origin/dev` `24b2f39b77` on 2026-09-27. The seven candidate heads were fetched as `t4/pr<N>` for read-only comparison. `git merge-tree --write-tree origin/dev t4/pr<N>` was used to identify textual conflicts without changing the checkout. All candidates target `dev`.

| PR | Head | Commits behind current dev | Merge-tree conflicts | Initial ownership judgment |
|---|---|---:|---|---|
| #6058 | `0798999c6f` | 51 | none | Routed model capability editor; lane-owned. Current CodeRabbit finding permits a positive fractional context window that floors to zero. |
| #5617 | `f65144160d` | 369 | `app-routing.ts`, `Providers.tsx`, `structure/config.md` | Global visibility and provider-local visibility semantics; potentially lane-owned, but must reconcile with the current catalog and Models UX. |
| #4932 | `99f3abc39f` | 317 | `combo-routes.ts` | Mixed combo Vision Sidecar enrollment; lane-owned. Branch lacks `vi.ts` although current GUI has ten locales. |
| #4649 | `c9b24c20bf` | 317 | none | Remembered admin token for #4644; lane-owned with an auth/security review gate. |
| #5932 | `e4387ea001` | 126 | provider workspace `types.ts` | Antigravity account plan presentation; overlaps account-pool lane's provider workspace files. |
| #2355 | `ec0c68daca` | 2,971 | eight runtime, CLI and GUI files | Config-versus-running-proxy warning; old architecture and broad shared-file collisions. |
| #5408 | `d4112b3e5d` | 108 | six provider/account files | 7,790 added lines and account-pool overlap; release suitability assessment only per lane assignment. |

Current issue status: #4644, #3379 and #4189 are open. #4644 tracks standalone Safari AutoFill and depends on the security verdict for #4649. #3379 already had journal deletion and custom usage ranges landed; selector naming remains and overlaps the picker/account lane. #4189 conflates ZCode client integration with Z.AI provider login; the existing issue discussion describes both interpretations, but the current code must be checked before disposition.

The candidate files, comments and later `dev` movement are point-in-time evidence. Recheck heads and merge bases immediately before any carry or merge.
