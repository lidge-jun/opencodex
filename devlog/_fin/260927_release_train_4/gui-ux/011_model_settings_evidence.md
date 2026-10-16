# Phase 010 — build and browser evidence

The #6058 carry is on `codex/t4-gui-ux-model-settings`. The contributor commit is `bb779ff13d` with its original author, followed by lane repairs `0d2d7ff0f7`, `1a61f6773c` and `03928972b5`, each with a `Co-authored-by` trailer. Every audit item in `010_model_settings.md` is implemented. Browser QA also found and fixed a defect that the unit tests missed.

## What changed beyond the plan

- **Menus behind the modal (found in browser QA).** The Context window and Default level menus portaled to `<body>`, under the modal's top layer. The dialog's backdrop button took their clicks, so the context window could not be changed by pointer (`08-pre-fix-menu-behind-modal.png`). Both menus now render inside the dialog (`portal={false}`), matching `gui/src/pages/dashboard-dialogs.tsx:53`. A regression test fails without the fix and passes with it.
- **Modality seeding.** On an undeclared row every modality box starts unticked, meaning "follow upstream". Ticking `image` to add image support used to declare the model image-only. The first tick now starts from the modalities the row already follows.
- **Codex catalog versus dashboard list.** `catalogRefresh` describes the Codex app's catalog, while the dashboard reads the saved config directly. A non-retryable skip (no managed catalog) is therefore a clean save. A failed or retryable refresh is a warning after the save and does not trap the dialog. Only a failed dashboard list reload enters the read-only stale state, which uses the warning tone because the save succeeded.

## UX state results (isolated proxy, direct `startServer`, port 18761)

Each state below was clicked through in a real Chrome browser, driven by Playwright with the system Chrome. The config file in the isolated `OPENCODEX_HOME` was read back after each write.

| State | Observation |
|---|---|
| Row entry | `Edit` appears only on routed rows, after Name and Price. Keyboard Enter opens the dialog and focus lands inside it. |
| Save one axis | Ticking `image` sent only `inputModalities`. Config read back as `["text","image"]`. Focus returned to the row's Edit button. |
| Reopen | The declared boxes are ticked. A saved context window of `128000` reopens as 128k. |
| Invalid input | Custom `0.5` shows "Context windows must be positive whole numbers" and makes no write (config unchanged). |
| Restore | The confirm dialog appears; after confirming, the declaration is removed from config. |
| Unknown outcome (PUT aborted) | Apply and Restore are disabled, while Cancel, Close and Escape work. Focus moves to Reload. Config is unchanged. |
| Saved, list reload failed | The warning notice appears with Apply and Restore disabled. Reload then closes the dialog with "reopen" feedback. |
| Keyboard | Tab cycles through the dialog's controls. The only stop outside is `<body>`, which is Chrome's native modal browser UI stop; the page behind stays inert. |
| 400px ru, de and en; 1360px ja | Page `scrollWidth` equals the viewport. The form's `scrollWidth` equals its `clientWidth` (378). The long title and reasoning labels wrap, and the actions stack full width. |

The real-home sentinel files (`~/.grok/config.toml`, `~/.codex/config.toml`, Claude settings, Claude Desktop config, `~/.zshrc`, `~/.opencodex/config.json`) hashed identically before and after QA.

Screenshots are on `pr-assets` at [`f3f98330`](https://github.com/lidge-jun/opencodex/blob/f3f98330421483b49050d65e2e09d6ead4467202/260928-t4-gui-model-settings).

## Commands

| Command | Where | Result |
|---|---|---|
| `bun test tests/server/model-settings-management-api.test.ts tests/cli/cli-models-set.test.ts tests/codex-integration/codex-convergence-contract.test.ts` | lane worktree | 48 pass, 0 fail |
| `cd gui && bun test tests/model-settings-dialog.test.tsx tests/locale-parity.test.ts` | lane worktree | 22 pass, 0 fail (17 dialog + 5 parity at final head) |
| `bun run typecheck`, `bun run lint:gui`, `cd gui && bun run lint:i18n`, `bun run build:gui` | lane worktree | all exit 0 |
| `bun test tests/ci-workflows/file-size-ratchet.test.ts` | lane worktree | 9 pass (`Models.tsx` 2,788 of 2,792) |
| `bun run privacy:scan`, `bun run structure:check`, `bun run skill:surface:check` | lane worktree | pass |
| `bun run test:changed` | `/private/tmp/t4-gui-ux-verify` at `03928972b5` | 6,011 pass, 2 skip, 0 fail, 297 files |

The full local suite was not run because seven lane worktrees share this machine; CI runs the full suite on the PR head.
