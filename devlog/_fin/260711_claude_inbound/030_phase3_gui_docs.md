# 030 — Phase 3: GUI "Claude Code" section + docs

Work class: **C2** (conventional settings slice + docs). One PABCD cycle.
Depends on: Phase 1-2 shipped (config.claudeCode consumed, discovery live).

**AMENDED 2026-07-11 (user spec, supersedes the "section on Models page" default):**

1. **Sidebar "Claude ON" toggle** — in `gui/src/App.tsx` `sidebar-foot`, ABOVE
   the `lang-toggle` (language selector) block. Label is the LITERAL string
   "Claude ON" in every locale (not translated; i18n key `claude.toggle` exists
   but its value is identical across en/ko/zh/de). Semantics: reflects + flips
   `config.claudeCode.enabled` via `GET/PUT /api/claude-code`; button carries an
   active state (same visual family as `theme-toggle`); while OFF the inbound
   `/v1/messages*` routes answer 403 `permission_error` "Claude inbound disabled"
   and Anthropic-flavored discovery returns `{data:[]}`. Default `enabled: true`
   (loopback-only surface; the toggle is a kill switch, not an arming ritual).
2. **Dedicated nav tab "Claude"** — new NAV entry in App.tsx directly BELOW the
   `api` item (`{id:"claude", tkey:"nav.claude", Icon:<sparkle/bot-ish lucide>}`)
   rendering new `gui/src/pages/ClaudeCode.tsx`: enable state, quickstart
   (`ocx claude` one-liner + manual env block for non-ocx launches), slot pickers
   (default/haiku over the routed-model list, reusing the Subagents fetch
   pattern), modelMap editor (key/value rows), discovery alias preview (count +
   first N aliases with display names).
3. Everything else in this doc (management API pattern, i18n 4-locale sync,
   docs-site 3-locale article, README rows) unchanged.

## Objective

Users configure the Claude side from the EXISTING dashboard (D2: no separate
app/port) and every public doc surface explains the feature: GUI section,
docs-site article (3 locales), README row (3 locales).

## Design

### Management API

- `src/server/management-api.ts`: `GET/PUT /api/claude-code` -> read/patch
  `config.claudeCode` (validate: model ids exist in registry or are aliases;
  modelMap keys non-empty; reject unknown fields). Follow the existing
  subagentModels endpoint pattern incl. saveConfig + broadcast.

### GUI (gui/src)

- New section on the Models page (or a dedicated page if Models is crowded —
  decide at A with a screenshot; default: section on Models):
  - Slot pickers: `default model` / `small-fast model` — dropdowns over the same
    routed-model list the Subagents page uses (reuse its fetch/store).
  - modelMap editor: key/value rows (inbound id -> routed id), add/remove.
  - Discovery status hint: read-only line showing the alias count exposed to the
    picker, with the `ocx claude` one-liner for setup.
- i18n: new keys in `gui/src/i18n/{en,ko,zh,de}.ts` — all four locales in the
  same commit (repo convention observed in git log: i18n sync ships with the
  feature).
- Design constraints (cxc-dev-frontend basics): reuse existing form components,
  no new cards-in-cards, dropdown + segmented patterns already on Models page.

### docs-site

- `docs-site/src/content/docs/guides/claude-code.md` (en) + `ko/` + `zh-cn/`
  translations; astro.config.mjs sidebar entry (after the CLI reference or in
  Guides — match the model-ordering unit's placement pattern).
- Content: quickstart (`ocx claude`), how discovery/picker works (with the
  prefix-alias explanation), slot mapping table, manual env setup for non-ocx
  launches, count_tokens approximation note, troubleshooting (version gate,
  auth on non-loopback).

### README

- `README.md` / `README.ko.md` / `README.zh-CN.md`: one feature row + a short
  "Claude Code" subsection mirroring the Codex quickstart block.

## Out of scope

- No behavior changes to the inbound/translators (any bug found here files into
  040, unless release-blocking).
- No de docs-site locale (site has en/ko/zh-cn only; de exists only in GUI i18n).

## Test plan (C gate)

- `tests/`: management-api claude-code GET/PUT round-trip + validation rejects;
  i18n key-parity check if a suite pattern exists (verify: rg for existing i18n
  tests) else add a minimal key-diff test.
- `cd gui && bun run build` green; docs-site `bun run build` (astro check) green.
- Visual: GUI section screenshots (desktop + narrow width) reviewed before D;
  text fits, no layout shift on dropdown open.
- Commands: `bun test ./tests/`, `bun x tsc --noEmit`, both builds above.

## Gate criteria

1. Config edited in GUI survives daemon restart and changes live routing
   (smoke: switch small-fast slot, see haiku-slot traffic move in Logs).
2. Docs build + sidebar link verified in local preview; ko/zh translations
   present (no placeholder English bodies).
3. Full suite + typecheck + both builds green.

## Risks

- Models page crowding -> fallback is a dedicated page; decision recorded at A
  with screenshot evidence, not re-litigated at B.
- i18n drift (de often lags): key-diff test makes it mechanical.
