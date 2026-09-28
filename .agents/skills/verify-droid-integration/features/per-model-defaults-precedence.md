# Per-model defaults and precedence

The Droid settings editor lets a user select a declared reasoning effort for an exported model. The selection is used only when a request omits its own reasoning effort.

## Sub-features

- `droid-default-choice` chooses a supported effort or No default for an exported model.
- `droid-default-apply` persists the choice as part of the reviewed integration change.
- `droid-request-precedence` preserves an explicit request effort over the configured default.
- `droid-default-model-scope` applies a choice only to its selected model.

## How to get to it (user POV)

- Open `/#integrations/droid` or choose **Integrations** in the sidebar, then **Factory Droid**. Use the per-model reasoning defaults panel.
- Choose an exported model and one of its supported effort values, or No default.
- Review and confirm the integration change to persist an edit.
- Use the local `request` helper to verify the saved default and explicit request precedence at the mock boundary.

## Driving it with agent-browser

Preconditions:

- On macOS or Linux, make sure `lsof` and `ps` are available on `PATH`.
- Launch and doctor a fresh isolated harness run at `http://127.0.0.1:12587/`.
- Apply Droid in the dashboard and confirm the reviewed plan. In a fresh run, Apply must precede editing/saving per-model defaults because the harness starts with an empty `.factory/settings.json`.
- Use `droid-fixture/ladder-alpha` and `droid-fixture/ladder-beta`. Both have low, medium, and high; `droid-fixture/no-ladder` has no effort choices.

- **Inspect choices.** The select named **Default reasoning effort for Ladder Alpha** offers **No default**, **low**, **medium**, and **high**. The no-ladder model remains visible with **No default available** and no select.
- **Choose a default.** Select **medium** for alpha and click **Save / review changes**. Review the dialog and confirm **Apply**. After reload, the select remains **medium**.
- **Check omission behavior.** Run `bun .agents/skills/verify-droid-integration/scripts/harness.ts request <run-id> ladder-alpha none`. Its sanitized output reports `effort: "medium"`, the expected model and route, and `privateDefaultHeaderAbsent: true`.
- **Check explicit precedence.** Run the helper with `top=high`. The capture reports `high`, overriding the saved default. Then run `nested=low`; the helper sends the identical native Chat body with and without the Droid header and asserts that upstream effort is unchanged. Native Chat's existing builder does not forward nested `reasoning.effort`, so this comparison verifies the header preserves the baseline behavior rather than claiming the nested field is forwarded.
- **Check model scope.** Run `request <run-id> ladder-beta none` without saving a beta default. The capture reports `effort: null`.
- **Proof.** Capture the editor and review dialog. The helper keeps only the sanitized upstream summary as evidence.

The control names above are the English source labels. When the dashboard is localized, use the matching translated visible labels and dialog buttons.

## Gotchas

- Editing is local until review and confirmation. A changed control alone is not persistence proof.
- Defaults apply only when the request omits both supported effort locations. Even an invalid, null, or `none` value counts as explicit presence under the contract.
- The helper accepts only the seeded model names and none/top/nested effort modes listed in the skill entrypoint.
- Pins and effort caps remain authoritative.
- The private header must be absent upstream. The mock reports only a boolean for this check and never exposes headers or bodies.
