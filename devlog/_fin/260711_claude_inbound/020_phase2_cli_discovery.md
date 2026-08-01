# 020 — Phase 2: `ocx claude` launcher + gateway model discovery

Work class: **C2-C3** (CLI slice + one new data-plane list surface). One PABCD
cycle. Depends on: Phase 1 shipped; 002 claims 4-6 (discovery protocol).

**AMENDED 2026-07-11 (WP1 hardening — Task 0 is DONE, see 003_evidence.md):**

- Task 0 (Tier-2 verification) completed via parallel explorers; all D6 claims
  CONFIRMED. Env var `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, min
  v2.1.129, request `GET /v1/models?limit=1000`, contract
  `{data:[{id, display_name?}]}` ONLY (no pagination fields read), prefix rule =
  id must literally BEGIN WITH `claude` or `anthropic` (G1-G3).
- Detection signal (finalized): serve the Anthropic discovery shape when the
  request carries an `anthropic-version` header OR `?flavor=anthropic`; keep
  `client_version` (Codex catalog) and default OpenAI list byte-stable.
- Discovery has a 3s client timeout + redirects=failure (G8): the branch must
  answer from the in-process/catalog cache — no blocking network refresh.
- Alias `claude-ocx-<provider>--<slug>` satisfies the prefix rule (begins with
  `claude`); `display_name` = `"<model> (<provider>)"` — honest, no "Claude" in
  the display name for non-Anthropic models.
- Launcher env (E1/E2): inject `ANTHROPIC_AUTH_TOKEN` ONLY (never also
  `ANTHROPIC_API_KEY`); slots via `ANTHROPIC_MODEL`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` (+ legacy `ANTHROPIC_SMALL_FAST_MODEL` for
  pre-deprecation versions — harmless duplicate); do not override vars the user
  already exported (respect explicit user env).
- `HEAD /` startup probe may hit the daemon (E4) — any non-5xx response is fine;
  verify the static handler answers HEAD.
- Picker persistence: selection writes settings.json `model` (G6) — aliases must
  therefore stay STABLE across releases; format changes are breaking.

## Objective

`ocx claude [args...]` starts/finds the proxy and launches Claude Code fully
wired (base URL, auth token, model slots, discovery flag) — and the native
`/model` picker lists opencodex's routed models via the official gateway model
discovery protocol with honest display names.

## Task 0 (blocking, A-gate input): Tier-2 verification of discovery

Open and archive (agbrowse fetch, quotes into 003_evidence_discovery.md):

- code.claude.com/docs/en/llm-gateway-protocol — exact `GET /v1/models` response
  schema (`data[].id`, `display_name`?), the claude/anthropic id-prefix rule,
  minimum version (claimed 2.1.129), header/auth expectations.
- code.claude.com/docs/en/llm-gateway-connect — env var exact name
  (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`), settings.json alternative,
  whether picker selection persists to `model` in settings.
- code.claude.com/docs/en/env-vars — `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
  `ANTHROPIC_CUSTOM_MODEL_OPTION` (fallback for pre-discovery versions).

If any claim fails verification, amend D6 here BEFORE building the alias layer.

## Design

### Alias layer — new `src/anthropic/alias.ts`

- Deterministic, reversible: routed `"<provider>/<model>"` <->
  `claude-ocx-<provider>--<model-slug>` (exact format finalized by Task 0's
  prefix rule; `--` separates provider from model; slug keeps [a-z0-9.-]).
- `aliasForRoute(provider, modelId)` / `resolveAlias(id)` — pure functions +
  collision test. `resolveInboundModel` (Phase 1) gains alias resolution BEFORE
  modelMap lookup.

### Discovery list — `src/server/index.ts` `/v1/models` branch

- Detect Anthropic-client callers (Task 0 decides the signal: `anthropic-version`
  header / `x-api-key` presence; fallback `?flavor=anthropic`) and return
  discovery entries for the SAME visible routed set the Codex catalog exposes
  (`filterCatalogVisibleModels` + `orderForSubagents`):
  `{ id: alias, display_name: "<model> (<provider>) — opencodex", ... }`.
- Codex/OpenAI callers keep today's shapes byte-identical (suite proves).

### Launcher — new `src/cli/claude.ts` + registration

- Ensure proxy: reuse `handleEnsure` flow (`findLiveProxy` -> detached spawn of
  `start` -> wait loop). Respect `codexAutoStartEnabled`.
- Env injection: `ANTHROPIC_BASE_URL=http://127.0.0.1:<live.port>`,
  `ANTHROPIC_AUTH_TOKEN` (= `OPENCODEX_API_AUTH_TOKEN` if set, else placeholder),
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`,
  `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` from `config.claudeCode`
  (values may be aliases or raw routed ids — both resolve inbound).
- `spawn("claude", args, {stdio:"inherit"})`; ENOENT -> install hint
  (`npm install -g @anthropic-ai/claude-code`); exit-code passthrough.
- `src/cli/index.ts` `case "claude"`, `src/cli/help.ts` usage row
  (`ocx claude [claude args...]`).

### Config

- Consume `config.claudeCode` (typed in Phase 1): `model`, `smallFastModel`,
  `modelMap`. No GUI yet (030).

## Out of scope

- GUI settings, docs-site, README (030). Statusline template (non-goal, 002 §3).
- Windows `claude.cmd` spawn quirks beyond `shell:false` + documented fallback.

## Test plan (C gate)

- `tests/anthropic-alias.test.ts`: round-trip for every provider name shape in
  the registry (dots, hyphens, slashes in model ids); prefix-rule compliance.
- `tests/models-discovery.test.ts`: Anthropic-flavored `/v1/models` returns
  aliased entries + display_name; Codex catalog shape and OpenAI list shape
  unchanged (regression fixtures).
- CLI: help includes `claude`; spawn-arg/env unit test following the pattern in
  `tests/codex-exec-invocation.test.ts` (env dict assembled, not a real spawn).
- Commands: `bun test ./tests/`, `bun x tsc --noEmit`.
- Manual smoke: `ocx claude` -> `/model` picker shows "From gateway" entries;
  select a Gemini alias -> streamed turn logs the resolved provider/model.

## Gate criteria

1. Task 0 evidence doc exists with quoted schema + prefix rule (claims promoted
   to Tier 2) — or D6 amended.
2. Suite + typecheck green; existing /v1/models consumers byte-stable.
3. Manual smoke above completed on a real Claude Code >= min version.

## Risks

- Picker prefix rule stricter than documented (e.g. exact `claude-` only) ->
  alias format is a single constant, changeable without churn.
- Older Claude Code without discovery: launcher still works (slots via env);
  document `ANTHROPIC_CUSTOM_MODEL_OPTION` fallback in help.
- Alias leakage into logs/usage: request-log records the RESOLVED provider/model
  (Phase 1 behavior), alias only appears as requestedModel — verify in smoke.
