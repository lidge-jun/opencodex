# 261002 Claude Code CLI first-party picker — plan (010)

## Problem

With `claudeCode.cliFirstParty` on, the standalone `claude` CLI talks to OpenCodex's intercept
proxy, but its `/model` picker only lists Anthropic models. Claude Desktop's picker mode already
injects opencodex routes into Desktop's claude.ai bootstrap catalog; the CLI has no equivalent.

## Evidence (live probe, Claude Code 2.1.287, first-party OAuth, throwaway capture proxy in .tmp/)

- The CLI builds `/model` from `GET https://api.anthropic.com/api/organizations/<org>/model_selector/cc`
  (`/api/model_selector/cc` for token/api-key auth). Body: `{model_selector_state, model_selector_config:
  [{id:"cc", models:[…Desktop-shaped rows…]}]}`. User-Agent `claude-cli/<v> (external, cli)`.
- Debug log: `[servedCatalog] primary: … the served list replaces the compiled picker`.
- Rows appended to the cc surface appear in `/model` and are selectable when the id is Claude-shaped:
  `claude-opus-4-8-20260919`, `claude-opus-4-8-p1ab`, `claude-opus-4-8-k3x`, `…[1m]` all worked.
  `gpt-6-luna`, `ocx-claude-native--gpt-6-sol`, `ocx-claude-xai--grok-4.7` render
  "Update Claude Code to use this model" (unselectable). So the Desktop-picker `ocx-claude-*` ids cannot
  be reused; the Desktop 3P registry ids (`activeDesktop3pAlias`) can.
- The CLI caches the served catalog ~1 h in `<claudeConfigDir>/cache/model-catalog/<org>-<hash>-cc.json`
  and does not refetch while fresh, so a toggle needs that cache invalidated.
- When the served catalog flag is off, the CLI falls back to the compiled picker plus
  `additional_model_options` from `GET /api/claude_cli/bootstrap` (UA `claude-code/<v>`), shape
  `{model, name, description, disabled_reason?}`.

## Diff-level plan

1. `src/claude/intercept/picker-bootstrap.ts`: `PickerModelEntry.description?`; `injectPickerModels(body, models,
   explain?, options?: {surfaces?, strip?})` — defaults unchanged for Desktop (`ccd`,`code`); when an entry carries
   a description it is written after stripping.
2. New `src/claude/intercept/cli-catalog.ts` (no heavy imports): `cliCatalogKind(method, path)`,
   `rewriteCliCatalogBody(kind, text, models)` (cc surface via injectPickerModels with surfaces `["cc"]` and extra
   strip `notice`, `selection_notice`; bootstrap appends `additional_model_options` rows not already present),
   `rewriteCliCatalogResponse(response, kind, models)` (2xx JSON only, size cap, drops content-length/etag,
   untouched bytes on any failure), `cliCatalogEligible(kind, userAgent, desired)` (model_selector: client's own
   intent via interceptRouteFor; bootstrap: `desired.cli` and not a Desktop entrypoint),
   `invalidateClaudeCodeServedCatalog(claudeDir)` (unlink `*-cc.json` only).
3. `src/claude/intercept/picker-models.ts`: extract shared candidate/profile rendering; add
   `buildCliPickerModels(input)`: skip real Anthropic routes, alias = `activeDesktop3pAlias`, keep only when
   `resolveDesktop3pAlias(alias) === route` (never advertise an id the router cannot decode), 1M marker as in
   Desktop, name = label, description `opencodex · <route>`. `createPickerModelSnapshot(load, path, build?)` and the
   persisted-snapshot parser accept the optional description.
4. `src/claude/intercept/listener.ts`: optional `cliCatalog(req, kind)` hook; for a matching GET, relay upstream
   (same upstream choice as today) and rewrite when models are returned. Messages dispatch unchanged.
5. `src/claude/intercept/runtime.ts`: when picker routes and desired clients are wired, build a CLI snapshot
   (`claude-intercept/cli-picker-models.json`), lazily refreshed (stale 5 min; first request waits ≤2.5 s), and pass
   the hook. No timers, no discovery unless an eligible catalog request arrives.
6. `src/server/management/agent-settings-routes.ts`: after a successful `cliFirstParty` change, invalidate the CLI
   served-catalog cache (best effort) so the next `claude` launch refetches through the proxy.
7. Tests: new `tests/claude-integration/claude-cli-picker.test.ts` (+ layout.json and test-layout-expected.json).
8. Docs: `docs-site/.../guides/claude-code.md` paragraph; `structure/runtime.md` sentence on the catalog rewrite.

## Verification

Focused tests, `bun run typecheck`, `bun run test:changed`, `structure:check`, `privacy:scan`; live: dev server
from this branch (isolated OPENCODEX_HOME with cliFirstParty + a provider that forwards to the running ocx),
`~/.claude/settings.json` env applied through the real apply path, plain `claude` in tmux → `/model` lists routes
→ pick one → prompt answered; settings and catalog cache restored afterwards.

## Risks

- Claude Code changes the catalog contract: rewrite is fail-open (unchanged bytes).
- Aliases depend on the Desktop 3P registry built at startup; unregistered routes are omitted, not guessed.
- UA classification is a hint, not a boundary (same as the Messages split).

