# Droid integration verification map

Use the isolated harness in [the skill entrypoint](../SKILL.md), then select the relevant user workflow below. Evidence lives under `.tmp/droid-integration-verification/evidence/<run-id>/` and survives cleanup.

## Baseline preconditions

- Run `bun .agents/skills/verify-droid-integration/scripts/harness.ts launch` and save its run ID.
- Require `doctor <run-id>` to pass before opening `http://127.0.0.1:12587/#integrations/droid`.
- The helper seeds two models with low, medium, and high effort ladders, one model with no ladder, an empty isolated `.factory/settings.json`, and a local mock provider.
- The fixture provider can reach only the helper mock at `127.0.0.1:12588`; no credentials are configured.
- Capture each action and visible result. Confirm saved state after reload and keep browser artifacts outside the run directory.
- Run `cleanup <run-id>` after the recipe. Cleanup preserves evidence.

## Driving conventions

- The sidebar has an **Integrations** entry. Droid is directly reachable at `/#integrations/droid`; there is no Settings parent.
- The connection switch reads **Apply** or **Disable**. The defaults panel exposes selects named **Default reasoning effort for <model label>** and a **Save / review changes** button.
- Review each consequence dialog before confirming. The relevant surfaces are `gui/src/pages/integrations/FileIntegrationPage.tsx` and `DroidReasoningDefaultsPanel.tsx`.
- The request helper captures only model, effort, route, and absence of the private Droid header.
- Record feature ID, run ID, action, visible result, and artifact paths. Never include credentials or request bodies.

## Features

- [Connect and settings lifecycle](./connect-settings-lifecycle.md) covers apply, refresh, disable, and restore.
- [Per-model defaults and precedence](./per-model-defaults-precedence.md) covers supported choices and request precedence at the local mock boundary.
- [Clear, refresh, and rollback](./clear-refresh-rollback.md) covers clearing values, capability changes, and restoring prior settings.
