# 040 — WP5: English restructure, splits, dedupe, pin refresh

Work-phase: `wp5-restructure`. Depends on: `020`. Parallel-safe with `030`
(disjoint file sets). Execute as one full PABCD cycle.

## File change map

| Path | Action |
|------|--------|
| `docs-site/src/content/docs/reference/configuration.md` | MODIFY — shrink to overview hub |
| `docs-site/src/content/docs/reference/configuration/providers.md` | NEW |
| `docs-site/src/content/docs/reference/configuration/routing.md` | NEW |
| `docs-site/src/content/docs/reference/configuration/agents.md` | NEW |
| `docs-site/src/content/docs/reference/configuration/server.md` | NEW |
| `docs-site/src/content/docs/reference/cli.md` | MODIFY — shrink to overview hub |
| `docs-site/src/content/docs/reference/cli/lifecycle.md` | NEW |
| `docs-site/src/content/docs/reference/cli/providers-accounts.md` | NEW |
| `docs-site/src/content/docs/reference/cli/agents.md` | NEW |
| `docs-site/src/content/docs/guides/sub-agent-surface.md` | MODIFY — beginner restructure + expand |
| `docs-site/src/content/docs/guides/codex-integration.md` | MODIFY — dedupe vs codex-app-models |
| `docs-site/src/content/docs/guides/codex-app-models.md` | MODIFY — dedupe vs codex-integration |
| `docs-site/src/content/docs/getting-started/quickstart.md` | MODIFY — pin refresh + human/agent pointer |
| `docs-site/astro.config.mjs` | MODIFY — nested sidebar groups for the new subpages |

Slug policy: `reference/configuration` and `reference/cli` keep their slugs (hub
pages); subpages nest under them (`reference/configuration/providers` etc.). No
existing slug is renamed or deleted.

## Split specs

### configuration.md (7,387 words → hub ~500 words + 4 domain pages)

- Hub keeps: file location (`~/.opencodex/config.json`), edit channels
  (GUI/CLI/file), precedence, safety note (secret fields), links to the four
  domain pages. 
- `configuration/providers.md`: provider entries, auth modes (API key/OAuth/
  subscription), baseUrl, adapter selection, model allowlists, quotas, context
  caps, per-provider notes currently inline in the monolith.
- `configuration/routing.md`: defaultProvider, model resolution order, combos
  config keys (details link to `guides/combos`), effort defaults, ordering.
- `configuration/agents.md`: multiAgentMode, subagentModels, injectionModel/
  Effort/Prompt, multiAgentGuidanceEnabled, syncCodexSubagentDefaults,
  subagentModelFallback(+PollMs), effort caps.
- `configuration/server.md`: port, bind/remote access + token rule,
  corsAllowOrigins, admission keys, storage/cleanup policy, sidecars, shadow
  calls, update/startup settings.

Rule: content MOVES, not copies — each moved section is deleted from the monolith
and the hub links to its new home. Nothing user-facing is dropped.

### cli.md (4,509 words → hub ~400 words + 3 family pages)

- Hub keeps: dispatch model, exit-code contract, headless behavior (management
  API round-trip, 503 when proxy down), `--yes` convention, links.
- `cli/lifecycle.md`: init/setup, start, stop, restart, ensure, status, health,
  doctor, restore/eject, recover-history, uninstall, service (all six
  subcommands), codex-shim, gui, update, sync/sync-cache, tray.
- `cli/providers-accounts.md`: provider/*, account/*, models/* (incl. custom
  models, visibility, selected-models, context caps).
- `cli/agents.md`: agent/*, v2, combo/route, access, observe+debug,
  integrations (claude, claude desktop, opencode, grok, client-config), system,
  config.

### sub-agent-surface.md — beginner restructure

Restructure to: What sub-agents are (30-second concept) → Choosing a mode
(v1/base/v2 decision table with "who should pick what") → How the mode works
(multi_agent_version stamping) → Delegation model & effort (injection settings,
guidance, budget) → Fallback chains → The encrypted-task limitation (#92) →
Managing (GUI/CLI/API) → FAQ. Expand with the `002` §Sub-agent facts (three-state
roster eligibility, placeholder list, marker-owned TOML writes, fail-safe sync).
Keep the existing slug and the existing help-modal link targets intact.

### Dedupe ownership

- `codex-integration.md` owns: setup/injection mechanics (how opencodex wires
  into Codex config, catalog sync, shims).
- `codex-app-models.md` owns: the app model picker UX (visibility, ordering,
  tiers).
- `sub-agent-surface.md` owns: v1/base/v2 + delegation/fallback.
Each page replaces duplicated explanations with one summary sentence + link.

### Pin refresh

- `quickstart.md:29` v2.7.1 → drop the pin ("current stable") or bump to 2.8.0;
  prefer dropping pins where the fact adds nothing.
- Same treatment for `codex-app-models.md:88`, `providers.md:313`,
  `sub-agent-surface.md:9`, `configuration.md:9` (keep "Since vX" only where the
  version genuinely gates behavior).
- Verify `cli.md:252` Codex 0.145.0 and `grok-build.md:101` 0.2.101 against
  current reality; keep with "as of" wording or drop.

## Acceptance criteria

- `wc -w` on `reference/configuration.md` ≤ 700 and `reference/cli.md` ≤ 600;
  subpages carry the moved content (spot-check 3 moved sections per split).
- Build route list contains the 7 new subpage routes per locale fallback.
- `rg -n "v2\.7\.1|v2\.7\.2" docs-site/src/content/docs` → no stale hits (or
  only intentional historical mentions).
- Dedupe: `rg` for the moved explanation paragraphs shows a single owner.
- `cd docs-site && bun run build` exit 0.

## Verification

Fresh docs build + word counts + rg checks above.
