# 030 — WP4: new English feature docs (beginner-friendly, detailed)

Work-phase: `wp4-feature-docs`. Depends on: `020` (nav slots land with these
pages). Execute as one full PABCD cycle; the four pages are disjoint files and may
be drafted by parallel sol/medium worker lanes.

## File change map

| Path | Action |
|------|--------|
| `docs-site/src/content/docs/getting-started/for-agents.md` | NEW |
| `docs-site/src/content/docs/guides/combos.md` | NEW |
| `docs-site/src/content/docs/reference/proxy-formats.md` | NEW |
| `docs-site/src/content/docs/reference/management-api.md` | NEW |
| `docs-site/astro.config.mjs` | MODIFY — sidebar entries for the four pages (with 4-locale translations) |

Locale ports are `050`'s job; this phase is English only.

## Page specs

### 1. `getting-started/for-agents.md` — "Agent Quickstart"

Audience: an AI agent (or scripting human) setting opencodex up non-interactively.
Sections:
- When to use this page (agent-driven terminals vs human dashboard).
- Setup: install → `ocx start` or `ocx service` → `ocx init` (what init writes,
  per `003` ground truth: config.json, optional Codex injection, optional shim;
  init never starts the proxy).
- The star-prompt rule, verbatim 3-sentence note from `003`, in a `:::caution`.
- Headless operation: management commands call the live proxy; unreachable →
  503/nonzero exit; `ocx status`, `ocx doctor`, `ocx health`.
- Adding providers/combos headlessly: `ocx provider add`, `ocx combo set`, with a
  pointer to `reference/cli`.
- Remote binds: token requirement (link `guides/web-dashboard` /
  `reference/configuration`).

### 2. `guides/combos.md` — "Combos: failover and load balancing"

Beginner-friendly but complete. Sections:
- What a combo is (one virtual model id `combo/<id>` fronting ordered targets) +
  a 60-second quickstart (`ocx combo set main --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol` style example using the real syntax from `002`).
- Config shape table: targets/strategy/stickyLimit/defaultEffort/alias, defaults
  and ranges from `002` (weights 1..10000, sticky 1..100, effort ladder).
- Alias rules + reserved names.
- Strategies: failover vs round-robin (smooth weighted RR + sticky batches),
  with a worked example timeline.
- Failure semantics: hop statuses (401/403/404/408/429/5xx) vs terminal errors;
  cooldown (60s default, Retry-After honored, 10 min cap); `combo_unavailable`.
- Effort defaults: when `defaultEffort` is applied vs omitted.
- The encrypted v2 sub-agent task rule (#92): native-only targets, the 400
  `unreadable_encrypted_agent_task` error, and the four recovery options.
- Managing combos: GUI, `ocx combo` CLI, `/api/combos` (link
  `reference/management-api`).
- Troubleshooting mini-FAQ (unknown combo 404, all targets cooled down, alias
  collision 409).

### 3. `reference/proxy-formats.md` — "Proxy API formats"

The wire-format deep reference. Sections per `002` §Proxy wire formats:
- Overview: one proxy, four API dialects + WS + realtime; translation pipeline
  (client dialect → internal Responses → adapter → provider).
- `POST /v1/responses` — accepted schema (model required, input shapes, tools,
  reasoning, previous_response_id, caching, service tier, penalties), JSON vs SSE
  output, usage token-detail guarantee, WebSocket upgrade on the same path
  (handshake auth, 426 fallback, frame shapes, warmup events).
- `POST /v1/chat/completions` — translation both directions, chunk format.
- `POST /v1/messages` + `/v1/messages/count_tokens` — Anthropic dialect,
  passthrough eligibility, `{input_tokens}`.
- `GET /v1/models` — the three emitted contracts and their trigger
  headers/params, in a table.
- `POST /v1/live` + realtime sideband — call creation + WS join normalization.
- `POST /v1/responses/compact` — native forward vs synthetic turn, `ocx1:` item,
  32 MiB cap, error vocabulary.
- Authentication per surface (X-OpenCodex-API-Key / bearer / x-api-key matrix) +
  error vocabulary (401, 403 origin_rejected, combo_unavailable,
  unreadable_encrypted_agent_task, upgrade_required 426).
- Encrypted-content hygiene paragraph (what the proxy will and will not touch).

### 4. `reference/management-api.md` — "Management API"

- Auth model: admin token sources, GUI session credentials (5 min, origin-bound,
  CSRF), remote-bind session issuance disabled.
- Error vocabulary (401/403/404/413/503 busy + Retry-After).
- Endpoint matrix by family (from `002` §Management API): agent settings, combos,
  config/settings/startup/update, logs/usage/storage, models/catalog, OAuth
  accounts/keys, providers, sidebar (star + `agent_consent_required`), system,
  stop, codex-auth delegation. Each row: method+path, purpose, notable errors.
- Note that the dashboard at localhost:10100 is a client of this API, and
  headless `ocx` commands use it too.

## Writing rules (all four pages)

- Beginner-first: concept → quickstart → details → reference tables.
- Every behavioral claim traces to `002` anchors; re-verify each anchor against
  current source at build time (stale check) and fix the doc, not the fact.
- Starlight components allowed: `:::note`/`:::caution`/`:::tip`, code blocks,
  tables, `<Steps>` where sequential. No new Astro components.
- Cross-link sibling pages; no content duplication (link, don't repeat).

## Acceptance criteria

- Four files exist at the exact paths; sidebar entries present with locale
  translation labels.
- `cd docs-site && bun run build` exit 0; the four routes appear in the build
  route list.
- `rg -n "unreadable_encrypted_agent_task|combo_unavailable|upgrade_required"
  docs-site/src/content/docs` hits in the new pages.
- No `path:line` anchors in the published prose (docs cite behavior, not line
  numbers — line anchors live in this devlog, not the public site).

## Verification

Fresh docs build + route list + link spot-check from sidebar to each new page.
