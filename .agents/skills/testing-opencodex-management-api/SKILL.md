---
name: testing-opencodex-management-api
description: Exercise the OpenCodex management API in a disposable, isolated development environment without touching personal client state.
---

# Testing the OpenCodex management API

## Isolation is a prerequisite

Use a disposable OS account, container, or VM with a disposable OS home. Do not run this
recipe in your normal desktop account merely by changing `OPENCODEX_HOME`.
That variable relocates OpenCodex state, not every client or shell integration.
On macOS, even disabling `claudeCode.systemEnv` can remove an existing managed block
from the OS home's `.zshrc`; `CLAUDE_CONFIG_DIR` does not redirect that file.
Raycast integration can also update existing OpenCodex-owned entries under the OS home.
A temporary client directory alone is therefore not a complete isolation boundary.

Within the disposable environment, allocate a unique scratch directory and set all of
`OPENCODEX_HOME`, `CODEX_HOME`, `GROK_HOME`, `CLAUDE_CONFIG_DIR`, and
`OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` to distinct directories inside it before startup.
Confirm the effective OS home belongs to the disposable account. Do not copy personal
tokens, client configuration, shell profiles, or keychain contents into this environment.

Save a scratch `config.json` under `OPENCODEX_HOME` with an unused loopback port:

```json
{
  "port": 19100,
  "hostname": "127.0.0.1",
  "codexAutoStart": false,
  "clientIntegrations": {"codex": false, "grok": false, "claude-desktop": false},
  "claudeCode": {"enabled": false, "injectAgents": false, "systemEnv": false}
}
```

Use both redirected client homes and integration disables. Disabled integrations may
still remove owned artifacts. `codexAutoStart` alone does not disable startup sync:
desired-state checks also consider integration settings and the hub/loopback-listener
role. Do not depend on any one flag as an isolation boundary.

## Start and authenticate

Install the repository's locked development dependencies and use the Bun version named
by `package.json`. Check that the selected Bun executable is available in this shell;
do not assume a particular developer's PATH layout. Start one foreground instance:

```sh
bun run src/cli/index.ts start --port 19100
```

Avoid `ensure`, tray, and service installation paths for this exercise: they can spawn
detached processes or alter persistent service state. Do not enable live providers or
submit billable traffic unless that separate test is explicitly authorized.

Prefer reading the scratch instance's generated `admin-api-token` locally. Alternatively,
provision a randomly generated `OPENCODEX_ADMIN_AUTH_TOKEN` used only for this test.
It must differ from every data-plane API key; a collision makes management authentication
unavailable. Never paste the token into a PR, screenshot, log, or tracked fixture.

Management requests accept `x-opencodex-api-key: <admin-token>` or
`Authorization: Bearer <admin-token>`. Missing authorization is refused. A valid token
does not bypass route-specific origin, session, or policy requirements. Keep requests
loopback-only and do not follow redirects with credentials.

## Focused Lab automation exercise

Read `GET /api/lab/automation` for policy and live scheduler state; inspect recorded runs
with `GET /api/lab/automation/runs`. Enabling automation is an explicit state change,
not a requirement for a basic management-authentication test.

A policy write uses `PUT /api/lab/automation`, for example:

```json
{"policy":{"enabled":true,"layers":{"protocolConformance":true}}}
```

Serialize policy writes. The read/merge and save do not share one lock, so concurrent
writers can overwrite each other's changes even though publication itself is atomic.
Re-read the policy after changing it.

A fixture-only manual run uses `POST /api/lab/automation/run` with this request body:

```json
{"evidenceLayer":"protocol_conformance","scenarioId":"responses-core.protocol.request-shape"}
```

For `live_route_compatibility`, include `providerName` and `modelId` in the POST request
body, not as substitute top-level configuration fields. The named provider must already
exist in `config.providers`, and live calls require authorization and suitable test
credentials. Consult `planManualLabRun` in `src/lab/automation/planner.ts` for accepted
combinations instead of guessing a scenario or provider.

The manual endpoint awaits dispatch and returns a run/trigger result. Inspect the returned
status rather than assuming success or a terminal run. Scheduler work is separate and
may not appear immediately; read the configured scheduler limits instead of sleeping for
a hard-coded interval.

## Stop and inspect

Send one interrupt to the foreground process and let its bounded cleanup/drain finish.
A clean shutdown exits with zero; cleanup or drain failures may exit nonzero. A second
signal requests forced termination and is not proof of successful cleanup.
Check that the test listener and any test-owned children have stopped before removing
the exact scratch tree. Do not clean directories based on a name pattern or age.
Capture only redacted status, exit code, exact test commands, and observed results.

This is a development testing recipe. It does not replace the operating reference in
`skills/ocx/` or the consent rules in `AGENTS_INSTALL.md`.
