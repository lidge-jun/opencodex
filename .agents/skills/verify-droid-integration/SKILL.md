---
name: verify-droid-integration
description: Verify Droid integration behavior in the opencodex dashboard and isolated proxy, especially per-model reasoning effort defaults.
---

# Verify Droid integration

Use this skill when changing or reviewing the Droid connection, per-model effort defaults, or restore behavior. Read [the feature index](./features/README.md) and the matching recipe first.

## Launch

Run from the repository root with Bun on `PATH`:

```sh
bun .agents/skills/verify-droid-integration/scripts/harness.ts launch
```

The harness currently supports macOS and Linux environments with `lsof` and
`ps` available on `PATH`. It uses these commands to verify listener and process
ownership before launch, during doctor, and during cleanup. Install/provide both
utilities before starting; do not substitute process-name matching.

The helper allocates a unique scratch run under `.tmp/droid-integration-verification/runs/`, seeds a credential-free provider catalog and `.factory/settings.json`, then sets `OPENCODEX_HOME` and `CODEX_HOME` to that run. It isolates Droid client-file access through `setIntegrationPathTestHooks`. The dashboard and normal server use `127.0.0.1:12587`, the fixture provider boundary uses `12588`, and the server's Claude intercept listener uses `12687`. All three listeners must be free before launch and owned by the run afterward. Readiness is an identity-checked `/healthz` response with the expected PID and port. The helper prints the run ID and direct dashboard route `http://127.0.0.1:12587/#integrations/droid`. Save the ID for doctor, request, and cleanup.

The model catalog and `.factory/settings.json` belong only to the disposable harness run. No credentials are configured and no real provider is contacted.

## Doctor

Before driving the dashboard, run:

```sh
bun .agents/skills/verify-droid-integration/scripts/harness.ts doctor <run-id>
```

Doctor checks the recorded process command, all three listeners, the health response identity, and dashboard HTTP status. Drive only the instance reported healthy by this command. If any check fails, stop and inspect the isolated run log.

## Drive

Use the direct dashboard route `http://127.0.0.1:12587/#integrations/droid`. The sidebar has an **Integrations** entry; there is no Settings parent. Drive the accessible controls by their visible names.

In a fresh run, Apply Droid and confirm its reviewed plan before using
**Save / review changes**: the harness starts with an empty `.factory/settings.json`,
and the defaults workflow is for an active integration. When the dashboard is
localized, use the translated visible control and dialog labels corresponding
to the English names in feature recipes; do not expect English text verbatim.

For screenshots and browser snapshots, use the installed `agent-browser` skill against this URL. Capture each action and its visible result. Save artifacts under `.tmp/droid-integration-verification/evidence/<run-id>/`; this directory is deliberately outside cleanup.

The fixture provider sends only to the mock at `127.0.0.1:12588`. Use `request` for model-path and precedence checks. The mock records only model, effective effort, route, and whether the private Droid header is absent; it never stores or prints request bodies or headers. Use `fixture` to remove a model or change its effort ladder. It restarts only the isolated proxy while retaining Droid state.

## Evidence

Evidence must show the user action and resulting state, plus a read-only confirmation of persisted settings where relevant. Keep screenshots, ARIA snapshots, and sanitized response summaries under `.tmp/droid-integration-verification/evidence/<run-id>/`. Never include credentials or request bodies. The request helper stores only the sanitized mock-boundary summary.

## Cleanup

Stop only the run ID created by this helper:

```sh
bun .agents/skills/verify-droid-integration/scripts/harness.ts cleanup <run-id>
```

Cleanup verifies the recorded process identity, stops that PID, waits for all three listeners to close, then removes that run's scratch homes and log. It retains evidence. Launch failures also stop the child it started and remove that run's scratch directory. Never kill by process name or clean another run's directory.

## Helpers

The executable harness is `scripts/harness.ts`. Its request command is `bun .agents/skills/verify-droid-integration/scripts/harness.ts request <run-id> <ladder-alpha|ladder-beta|no-ladder> <none|top=low|top=medium|top=high|nested=low|nested=medium|nested=high>`. Use `none` to test the saved Droid default, `top=...` to test explicit precedence, and `nested=...` to compare native Chat upstream behavior with and without the Droid header. For catalog scenarios, use `fixture <run-id> remove ladder-beta` or `fixture <run-id> efforts ladder-beta low`; `none` sets an empty ladder. For maintaining feature coverage as the UI changes, use `/maintain-verification-skill` when available.
