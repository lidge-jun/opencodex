# Connect and settings lifecycle

The Droid integration connects the dashboard's Droid client settings to the opencodex model catalog and presents a review step before each change.

## Sub-features

- `droid-connect` applies the integration after review and confirmation.
- `droid-status` shows whether the integration is connected and its current model choices.
- `droid-refresh` previews updated exported models and applies the confirmed refresh.
- `droid-disable` removes the integration-owned settings after review.
- `droid-restore` restores an earlier integration snapshot.

## How to get to it (user POV)

- Open `http://127.0.0.1:12587/#integrations/droid`, or choose **Integrations** in the sidebar and then **Factory Droid**.
- Use the connection switch labeled **Apply** or **Disable**.
- Use **Save / review changes** in the defaults panel to review an update.
- Use **Undo** or **Restore this point…** in rollback history to restore a previous change.

## Driving it with agent-browser

Preconditions:

- On macOS or Linux, make sure `lsof` and `ps` are available on `PATH`; see the skill entrypoint for why the harness requires them.
- Launch and doctor a fresh harness run. The fixture begins with an empty `.factory/settings.json`.
- Open its direct Droid route at `http://127.0.0.1:12587/#integrations/droid` and capture the initial status.

- **Apply.** Activate **Apply**. The dialog title is **Apply this integration?** Review its planned changes, then confirm with **Apply**. The connection switch changes to **Disable** and stays connected after reload. Apply must come before editing/saving defaults in a fresh run.
- **Refresh defaults.** Set a supported effort for an exported model, then activate **Save / review changes**. Review the plan and confirm with **Apply**. Reload and verify the selected value persists in the defaults panel/status. A changed value is needed to demonstrate a persisted update; an unchanged save can be a no-op.
- **Disable.** Activate **Disable**. The dialog title is **Disable this integration?** Review and confirm with **Disable**. The switch returns to **Apply** after reload.
- **Restore.** In rollback history activate **Undo** for the latest entry or **Restore this point…** for an older entry. Review the restore dialog and confirm with **Restore**. The previous state is visible after reload.
- **Proof.** Capture the initial state, each action and confirmation dialog, and the reloaded result. Keep screenshots and ARIA snapshots in `.tmp/droid-integration-verification/evidence/<run-id>/connect-settings-lifecycle/`.

The control and dialog names above are the English source labels. If the dashboard uses another locale, locate and use the translated visible equivalents rather than expecting English text.

## Gotchas

- Do not confirm a plan whose content differs from the intended operation.
- The helper seeds an empty isolated `.factory/settings.json`; apply first so defaults are managed as part of an active integration.
- A completed dialog alone does not prove persistence. Reload and inspect the connection switch and defaults panel/status.
- The external provider boundary is not part of this lifecycle; use the fixture request recipe for request behavior.
