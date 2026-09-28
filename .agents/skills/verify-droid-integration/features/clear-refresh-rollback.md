# Clear, refresh, and rollback

Users can remove one model's default, review capability changes during refresh, and restore earlier Droid settings together with their defaults.

## Sub-features

- `droid-clear-default` removes one selected model default with No default.
- `droid-refresh-preserve` preserves defaults for models that remain available.
- `droid-refresh-removed` previews removal of models no longer exported.
- `droid-refresh-effort-change` asks the user to clear a choice that is no longer declared.
- `droid-rollback-defaults` restores previous Droid settings and defaults together.

## How to get to it (user POV)

- Open `/#integrations/droid` or choose **Integrations** in the sidebar, then **Factory Droid**.
- Choose **No default** in a model select and use **Save / review changes**.
- Use the rollback history's **Undo** or **Restore this point…** action.

## Driving it with agent-browser

Preconditions:

- On macOS or Linux, make sure `lsof` and `ps` are available on `PATH`.
- Launch and doctor a fresh isolated harness run at `http://127.0.0.1:12587/`.
- Apply Droid and confirm the reviewed plan before editing defaults. The helper seeds an empty `.factory/settings.json`.
- The fixture seeds `ladder-alpha` and `ladder-beta`, each with **low**, **medium**, and **high**; `no-ladder` has no effort options. Set both alpha and beta defaults explicitly before the save steps below.
- Use only the `fixture` helper command to change the disposable catalog. It restarts this harness run and retains its Droid settings and history.

- **Seed supported defaults.** Set alpha to **medium** and beta to **high**. Click **Save / review changes**, inspect the plan, confirm **Apply**, reload, and verify both values persist.
- **Clear and undo while both values are supported.** Set alpha to **No default**, review and confirm the save, then reload and verify alpha is clear while beta remains **high**. Immediately choose **Undo** for that clear operation, review and confirm **Restore**, reload, and verify alpha is **medium** and beta is **high** again. This is the supported-state rollback assertion.
- **Change the effort ladder, then clear the unsupported value.** Run `bun .agents/skills/verify-droid-integration/scripts/harness.ts fixture <run-id> efforts ladder-beta low`. Return to Droid and reload if needed. Beta's saved **high** value is now unsupported; the panel reports **Some saved defaults are no longer supported. Clear them explicitly.** Use beta's **Clear default**, review the plan, confirm **Apply**, reload, and verify beta remains exported with no default while alpha remains **medium**. Do not Undo this clear: that would restore the saved **high** value against the current low-only ladder, so the resulting state must not be described as current/supported.
- **Remove the model after resolving its unsupported default.** Run `bun .agents/skills/verify-droid-integration/scripts/harness.ts fixture <run-id> remove ladder-beta`. Return to Droid and reload, use **Save / review changes**, inspect and confirm the removal plan. After reload verify beta is absent and alpha remains exported with **medium**. This final state is the expected removal result; do not infer it from the dialog alone.
- **Proof.** Save before/after screenshots and sanitized read-only state snapshots under `.tmp/droid-integration-verification/evidence/<run-id>/clear-refresh-rollback/`.

Use the English labels above as source names only. In a non-English dashboard, match the translated visible controls and dialog buttons; the accessible name will follow the selected locale.

## Gotchas

- The fixture command edits only this run's config and restarts only its recorded proxy process.
- A missing map on a mutation preserves defaults; an explicitly empty map clears them.
- Refresh preserves matching owned defaults and removes models only through the reviewed plan.
- Apply before the first defaults edit in a fresh run. Keep the supported clear/Undo check before lowering beta's ladder; restoring the later unsupported value would not prove a current supported state.
