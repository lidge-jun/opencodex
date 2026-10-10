# wp6 — #1107 opt-in authless Codex Desktop routing mode

Issue #1107 (score 71, enhancement/account-pool). No PR. Investigation by grok subagent (Hume) with
file:line evidence; see 061 for the audit.

## Facts that bound the design

- Loopback injection today is Design B (root `openai_base_url`); Codex keeps its built-in `openai`
  provider so Desktop's ChatGPT OAuth gate applies. Non-loopback injects the dedicated
  `[model_providers.opencodex]` table with `requires_openai_auth = true` + `env_key`
  (`src/codex/inject.ts:942-960`).
- Codex Desktop honors `requires_openai_auth = false` on a dedicated custom provider (issue
  diagnostic, confirmed by maintainer). There is no verified authless knob for the built-in provider;
  do not invent one.
- `injectCodexConfig` already strips every prior form before re-injecting (`:920-930`), and
  `removeCodexConfig`/`restoreNativeCodex` strip the table + root re-tag + injected base url. So
  a third loopback form is reconciled and restored by existing code.
- Catalog: both forms write the same `model_catalog_json`; entries are slug-based, not
  provider-tagged (`src/codex/catalog/sync.ts:286`). The "empty picker" in the issue's diagnostic is
  the Desktop renderer's native-only allowlist (documented in `guides/codex-app-models.md` §Desktop
  remote servers, upstream openai/codex#19694), which applies regardless of our form. Not fixable
  here; documented, with the same workaround (`model = "<provider>/<id>"` in config.toml).
- History: legacy provider mode runs the `apply-opencodex` history op (threads visible under the
  `opencodex` provider); restore runs `migrate-openai`. The authless mode reuses the legacy
  history semantics since threads are tagged `opencodex` exactly like non-loopback.

## Design

Config key (top-level, flat, next to the other Codex-injection switches):

```json
{ "codexDesktopAuthless": true }
```

- `src/types/config.ts`: `codexDesktopAuthless?: boolean` (doc: opt-in; loopback only; default off).
- `src/config.ts`: `codexDesktopAuthless: z.boolean().optional().catch(undefined)` (degrade-safe
  like `syncCodexSubagentDefaults`).
- `src/codex/inject.ts`:
  - `CodexRoutingTarget` gains optional `desktopAuthless?: boolean`.
  - `standaloneCodexRoutingTarget` sets `desktopAuthless: config.codexDesktopAuthless === true &&
    !requiresAdmissionToken`. Non-loopback (admission token required) never becomes authless; the
    `env_key` line and `requires_openai_auth = true` stay. Client-connect targets
    (`src/client/connect.ts`) are untouched.
  - `buildProviderTableBlockForTarget`: `requires_openai_auth = ${target.desktopAuthless ? "false" : "true"}`;
    `env_key` only when `requiresAdmissionToken` (unchanged).
  - `injectCodexConfig`: `const providerTableMode = routingTarget.requiresAdmissionToken ||
    routingTarget.desktopAuthless === true;` replaces `legacyMode` as the branch selector for
    root re-tag + table, profile shape, journal `injectedOpenaiBaseUrl`, history op, and headline
    (authless headline names the mode).
  - `buildProfileFileForTarget`: same selector so the fallback profile mirrors the live form.
- `src/server/management/config-routes.ts` `/api/settings`: GET returns
  `codexDesktopAuthless: config.codexDesktopAuthless === true`; PUT accepts boolean, `false`
  deletes the key, rollback on save failure; a change triggers `convergeCodexCatalog()` so the
  next inject rewrites config.toml (same pattern as the account picker).
- `src/cli/system-command.ts`: `ocx system settings --desktop-authless <on|off>` → PUT.
- Docs: `guides/codex-integration.md` new subsection "Authless Codex Desktop (opt-in)" after the
  dedicated-provider paragraph; `reference/configuration/server.md` table row. English only.

## Acceptance

- Default (key absent/false): byte-identical injection output to today (existing Design B and
  non-loopback tests untouched and green).
- Loopback + opt-in: config.toml has `model_provider = "opencodex"`, the table with
  `requires_openai_auth = false`, no `env_key`, no root `openai_base_url`; `model_catalog_json`
  still written; re-inject idempotent; fallback profile has the same shape.
- Switching opt-in → off then re-inject restores Design B (root `openai_base_url`, no table);
  `restoreNativeCodex` strips the authless form.
- Non-loopback + opt-in: still `requires_openai_auth = true` and `env_key` (admission unchanged).
- User-owned root `openai_base_url` is still respected in authless mode? — No: in provider-table
  mode the root key is not ours to manage and `model_provider = "opencodex"` wins routing, matching
  today's non-loopback behavior. The existing "user-owned" warning applies to Design B only.
- `/api/settings` round-trips; CLI flag sends the PUT.
- Focused: `tests/codex-inject.test.ts`, `tests/codex-inject-integration.test.ts`,
  `tests/settings-stream-mode.test.ts`, `tests/cli-headless-parity.test.ts`; tsc; privacy.

## Files

- src/types/config.ts, src/config.ts, src/codex/inject.ts,
  src/server/management/config-routes.ts, src/cli/system-command.ts,
  docs-site/src/content/docs/guides/codex-integration.md,
  docs-site/src/content/docs/reference/configuration/server.md,
  tests/codex-inject.test.ts, tests/codex-inject-integration.test.ts,
  tests/settings-stream-mode.test.ts, tests/cli-headless-parity.test.ts.

## Closure

PR to dev, `Closes #1107`. Close comment names the key, the CLI flag, the non-loopback guarantee,
and the documented picker caveat.

