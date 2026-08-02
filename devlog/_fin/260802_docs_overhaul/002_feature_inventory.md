# 002 — feature-surface inventory (research, no diffs)

Read-only inventory from `src/**`, branch `dev`, 2026-08-02. Every fact carries a
path:line anchor; documentation authors must re-verify anchors at build time (P of
each implementation cycle does the stale check).

## Combos

- Config: `combos: Record<string, OcxComboConfig>`; each combo = ordered `targets`
  of `{provider, model, weight?}` plus optional `strategy`, `stickyLimit`,
  `defaultEffort`, `alias`. Defaults: `strategy: "failover"`, `stickyLimit: 1`,
  `weight: 1`. Weights 1..10000, sticky 1..100, effort
  low|medium|high|xhigh|max|ultra (`src/types.ts:753-786`,
  `src/combos/types.ts:272-284`).
- IDs match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; canonical model id `combo/<id>`;
  alias rules: no `combo/` occupancy, no duplicates, no bare native names like
  `gpt-*`/`o1-*`/`o3-*`/`o4-*`/`codex-*`; canonical lookup wins before alias
  matching (`src/combos/types.ts:20-32,52-87,93-129`).
- Routing: request cloned, `model` swapped to `provider/model`, combo
  `defaultEffort` applied only when the caller did not set effort AND the target
  catalog advertises it (`src/combos/request.ts:19-61`).
- `failover` = first eligible target; `round-robin` = smooth weighted RR with
  sticky batches (`src/combos/resolve.ts:53-83,85-153`).
- Failure handling: hop on 401/403/404/408/429/5xx + classified auth/quota/
  overload errors; terminal on 499/origin_rejected/cyber refusal/context
  overflow/invalid request. Cooldown default 60s, honors `Retry-After`, cap 10 min
  (`src/combos/failover.ts:14-18,29-76,110-139`; `src/combos/resolve.ts:156-187`).
- Errors: unknown combo → 404 `invalid_request_error`; exhausted targets →
  `combo_unavailable` (`src/server/responses/core.ts:885-929`;
  `src/combos/resolve.ts:37-50`).
- Encrypted v2 worker tasks (#92): combo eligibility restricted to canonical
  native ChatGPT targets; none available → HTTP 400
  `unreadable_encrypted_agent_task` (`src/server/responses/encrypted-payload.ts`
  120-231; `src/server/responses/core.ts:903-929,685-698`;
  `tests/v2-agent-message-failfast.test.ts:169-249`).
- Management: `GET|PUT|DELETE /api/combos` (400/409/404 semantics)
  (`src/server/management/combo-routes.ts:71-80,83-200,203-217`).
- CLI: `ocx combo list|show|set|remove` (+ `create|update`/`delete` aliases,
  `ocx route combo` alias) (`src/cli/combo.ts:13-20,67-115`;
  `src/cli/index.ts:996-1008`).

## Sub-agent surfaces (v1 / base / v2)

- `multiAgentMode`: `v1` stamps every catalog model `multi_agent_version:"v1"`;
  `v2` stamps `"v2"`; unset/default restores upstream pins (Sol/Terra V2, Luna V1)
  and otherwise follows the native `multi_agent_v2` flag (`src/types.ts:657-662`;
  `src/codex/catalog/parsing.ts:303-337`; `src/cli/v2.ts:68-73`).
- V2 roster eligibility is three-state: `"v2"`, `null`, absent = eligible; a real
  `"v1"` pin is excluded (`src/codex/catalog/sync.ts:54-72`).
- `ocx v2 status|on|off|mode <v1|default|v2>|threads <n>` drives the native feature
  and catalog mode; applies to new sessions (`src/cli/v2.ts:1-11,38-59,76-172`).
- Keys: `subagentModels` (max 5; fresh default gpt-5.5, gpt-5.6-sol/terra/luna,
  gpt-5.4-mini), `injectionModel`/`injectionEffort`/`injectionPrompt`,
  `multiAgentGuidanceEnabled` (default true), `syncCodexSubagentDefaults`
  (default off), `subagentModelFallback` (default []),
  `subagentModelFallbackPollMs` (60_000) (`src/types.ts:542-567,606-618`;
  `src/config.ts:1047-1056,1995-2014`).
- Surface detection is tool-shape based: namespaced `spawn_agent` +
  send_input/resume/close = v1; flat spawn_agent + send_message/followup_task/
  interrupt/list_agents = v2 (`src/server/responses/collaboration.ts:139-166`).
- Guidance: v1 only at max/ultra effort, proactive text only; v2 gets proxy
  guidance (700-char budget, roster dropped first) when a preferred model, roster,
  or fallback chain exists; custom `injectionPrompt` placeholders `{{model}}`,
  `{{effort}}`, `{{roster}}`, `{{fallback}}`
  (`src/server/responses/collaboration.ts:131-137,216-280`).
- Guidance is a developer message, deduped in replay prefixes, inserted before a
  trailing `compaction_trigger` (`src/server/responses/collaboration.ts:301-332`;
  `src/server/responses/core.ts:812-829`).
- `syncCodexSubagentDefaults` writes marker-owned
  `[agents] default_subagent_model` / `default_subagent_reasoning_effort`;
  unmarked user fields conflict and block partial writes; ambiguous TOML rejected
  (`src/codex/inject.ts:76-82`; `src/codex/subagent-defaults.ts:413-473,476-549`).
- Fallback chain: primary → role `model_fallback` (`$CODEX_HOME/agents/*.toml`) →
  global `subagentModelFallback`; skips disabled/unroutable/unhealthy/cooldown/
  quota-threshold candidates; encrypted child tasks can force native-only
  (`src/codex/subagent-model-fallback.ts:82-105,175-227,387-412`).
- Management: `GET|PUT /api/v2`, `/api/injection-model`, `/api/effort-caps`,
  `/api/subagent-models`, `/api/subagent-model-fallback`
  (`src/server/management/agent-settings-routes.ts:154-214,302-415,421-520`).

## Proxy wire formats

- `POST /v1/responses`: Responses-style body, nonblank `model`; string or item
  array input; tools/tool_choice/stream/reasoning/previous_response_id/caching/
  service tier/penalties/output limits (`src/responses/schema.ts:3-159`). Output:
  completed JSON or SSE ending `[DONE]`; usage always carries token-detail objects
  (`src/bridge.ts:18-65,126-148,591-598,705-756,1214-1226`).
- `POST /v1/chat/completions`: translated into internal Responses and back;
  `chat.completion` JSON or `.chunk` SSE (`src/server/chat-completions.ts:1-5,
  79-91,354-359`).
- `POST /v1/messages` + `/v1/messages/count_tokens`: Anthropic Messages; routed
  via Responses round-trip or native Anthropic passthrough for eligible
  subscription auth (`src/server/claude-messages.ts:1-7,555-622,725-840,868-913`).
- `GET /v1/models` has three contracts: Anthropic flavor (`anthropic-version`
  header or `?flavor=anthropic`), Codex catalog (`client_version` header), plain
  OpenAI list (`src/server/index.ts:481-531`).
- Remote-bind admission: Responses/Chat-Completions require
  `X-OpenCodex-API-Key`; Messages/Models also accept bearer or `x-api-key`;
  401 missing auth, 403 `origin_rejected` (`src/server/auth-cors.ts:271-295,
  327-363`; `src/server/index.ts:650-767`).
- WebSocket: upgrade on `/v1/responses`; handshake auth; 426 `upgrade_required`
  when disabled (Codex falls back to HTTP); JSON frames in/out; warmup synthesizes
  `response.created`/`response.completed` (`src/server/index.ts:413-440`;
  `src/server/ws-bridge.ts:45-57,101-145`).
- Realtime/Live: `POST /v1/live`, `POST /v1/realtime/calls`; sideband WS joins
  normalized from `/v1/realtime`, `/v1/realtime/calls/<id>`, `/v1/live/<id>`,
  relayed transparently (`src/server/index.ts:769-832`;
  `src/server/live.ts:192-224,265-273`).
- Encrypted payload hygiene: misplaced plaintext in `encrypted_content` is split
  into text + valid Fernet runs; an agent_message that loses all encrypted parts
  is rewritten to a user message; genuine ciphertext stays byte-identical
  (`src/server/responses/encrypted-payload.ts:101-145,236-307`;
  `src/server/responses/core.ts:1197-1209`).
- `POST /v1/responses/compact`: native forward for ChatGPT/OpenAI routes;
  synthetic no-tools compaction turn otherwise requiring one `ocx1:` item; 32 MiB
  cap; error vocabulary 400/404/499/502/`upstream_error`/`invalid_response_error`
  (`src/server/responses/compact.ts:106-156,161-211,322-383`).
- Adapters: `openai-responses` (passthrough), `openai-chat`, `anthropic`,
  `google`, `kiro`, `azure|azure-openai`, `cursor`, `mimo-free`; unknown name →
  `Unknown adapter` (`src/server/adapter-resolve.ts:57-79` + per-adapter files).

## Management API

- Auth: `OPENCODEX_ADMIN_AUTH_TOKEN` or hardened `ocx_admin_*` file; header
  `X-OpenCodex-API-Key` or bearer; must differ from data-plane credentials
  (`src/server/management-auth.ts:162-187,234-266`).
- Loopback GUI sessions: 5-minute `ocx_session_*` credentials, exact-origin bound,
  CSRF on unsafe methods; disabled on remote binds
  (`src/server/management-auth.ts:27-47,207-231,249-263`).
- Errors: cross-origin 403; body over 2 MiB 413; missing/invalid admin 401;
  unavailable credential state 503; busy 503 `oauth_mutation_busy`/`catalog_busy`
  with `Retry-After: 1`; unknown route 404 `not_found`
  (`src/server/auth-cors.ts:92-112`; `src/server/management-api.ts:84-94,139-152`;
  `src/server/management-auth.ts:239-266`; `src/server/index.ts:448-453`).
- Route families (file → endpoints): `agent-settings-routes.ts` (/api/v2,
  injection-model, effort-caps, subagent-models, subagent-model-fallback, grok,
  claude-desktop, claude-code); `combo-routes.ts` (/api/combos);
  `config-routes.ts` (/api/config, settings, startup-health, startup-action,
  windows-tray, diagnostics, sync, update/*, sidecar-settings,
  shadow-call-settings); `logs-usage-routes.ts` (/api/logs, debug/*, usage,
  storage/*); `model-routes.ts` (/api/catalog, models, client-config,
  custom-models, selected-models, disabled-models, model-visibility);
  `oauth-account-routes.ts` (OAuth lifecycle, accounts, provider-keys, /api/keys);
  `provider-routes.ts` (/api/providers CRUD + test, quotas, context-caps,
  presets; 409 `provider_has_dependent_combos`); `sidebar-routes.ts`
  (/api/github/star — 403 `agent_consent_required` for agent callers;
  /api/update/badge); `system-routes.ts` (/api/system/memory, restart); the root
  dispatcher owns POST /api/stop and delegates /api/codex-auth/*.

## CLI

Authoritative dispatch `src/cli/index.ts:726-1095`; summaries
`src/cli/help.ts:13-251`. Families: lifecycle (`init|setup`, `start [--port]`,
`stop`, `restore|eject`, `ensure`, `restart`, `status`, `health`, `doctor`,
`recover-history`, `uninstall|remove`), background (`service
install|start|stop|status|uninstall|remove`, `tray`, `codex-shim`, `gui`,
`update`, `sync`, `sync-cache`), provider/account/models, `combo`/`route`,
`agent`, `v2`, `observe` (+ `logs|usage|storage|memory` aliases), `access`
(admission keys + smoke), integrations (`claude`, `claude desktop`, `opencode`,
`grok`, `client-config`), `system`, `config`, `debug`. Headless management
commands talk to the live proxy's management API; unreachable proxy → 503 →
nonzero exit (`src/cli/runtime-api.ts:43-88`). Destructive commands take `--yes`.

## Star-prompt contract (canonical for README + for-agents page)

- The one-time star prompt is eligible only on interactive-TTY `ocx start` /
  `ocx service install`, outside `OCX_SERVICE`, with authenticated `gh`, and no
  `.star-prompted` marker (`src/cli/star-prompt.ts:93-123`).
- Agent/CI detection suppresses the prompt and deliberately leaves the marker
  unwritten so the user still gets asked (`src/cli/agent-driven.ts:24-69`).
- Only an explicit human Yes calls `gh api -X PUT /user/starred/...`; the
  management `POST /api/github/star` independently refuses agent-driven callers
  with 403 `agent_consent_required` (`src/cli/star-prompt.ts:69-133`;
  `src/server/management/sidebar-routes.ts:27-72`).
- Repo rule: agents must relay the question to the user and act only on an
  explicit yes (`AGENTS.md` "User-consent actions").
