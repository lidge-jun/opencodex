---
title: Claude Code
description: Use any routed model from Claude Code — opencodex serves the Anthropic Messages API and gateway model discovery on the same port.
---

opencodex serves `POST /v1/messages` (plus `count_tokens`) alongside `/v1/responses`, so Claude
Code can use every routed provider — OAuth logins, account pools, key failover and sidecars
included — with zero extra auth work.

## Quickstart

```bash
ocx claude
```

`ocx claude` ensures the proxy is running, then launches Claude Code with the environment wired:

| Variable | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | Only when the proxy requires an API key — otherwise it is NOT set, so your claude.ai login (subscription + connectors) stays active |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (native `/model` picker discovery) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Auto-context compaction threshold (default `350000`); only injected when auto-context is enabled |
| `ANTHROPIC_MODEL` | `claudeCode.model` (optional) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.tierModels.haiku ?? claudeCode.smallFastModel` (optional; legacy `ANTHROPIC_SMALL_FAST_MODEL` too) |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE}_MODEL` | `claudeCode.tierModels.*` (optional) |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | `1` when `alwaysEnableEffort` is on (conditional) |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `DISABLE_COMPACT` | Legacy context override when `maxContextTokens` is set (conditional) |
Variables you export yourself always win. Extra arguments pass through: `ocx claude -p "hello"`.

## System environment integration (macOS)

## Claude Desktop profile

Claude Desktop uses a separate profile from Claude Code. Open **Claude → Desktop** in the
dashboard to place each available route in one of four families: Opus, Fable, Sonnet, or Haiku.
All routes start in Opus on a new profile. The first Opus route becomes the initial overall
default, and every non-empty family always has one family default.

Drag a row to another family if you like. Dragging is optional: every row also has a visible move
control that works with a mouse, touch, or keyboard. Use **Make default** to choose a family's
default, then select **Save and apply to Desktop**. Empty families are allowed. If a saved default
is temporarily unavailable, the first available route in that family is used until it returns.

You can also manage the same profile from the command line:

```bash
ocx claude desktop [apply]
ocx claude desktop show [--json]
ocx claude desktop move <route> <opus|fable|sonnet|haiku> [--default]
ocx claude desktop default <opus|fable|sonnet|haiku> <route|none>
ocx claude desktop export <path|->
ocx claude desktop import <path> [--apply]
```

`ocx claude desktop` and `apply` both write the current profile to Claude Desktop. `show` gives a
readable summary; add `--json` for scripts. `export -` writes versioned JSON to standard output.
Import validates the complete file before saving, so an invalid file leaves the current profile
unchanged. Add `--apply` to write a valid imported profile to Desktop immediately. Use `none` only
for an empty family; every non-empty family must keep one default.

Non-Anthropic routes receive stable aliases such as `claude-opus-4-8-2026MMDD`. The date-looking
part is a synthetic route slot, not the model's release date. Real Anthropic Claude routes keep
their real ids. New routes default to the Opus family, but moving a route does not change the
provider or model it calls. The legacy apply flags `--static`, `--hybrid`, and `--discovery-only`
remain available for existing scripts.

## System Environment Integration

When `claudeCode.systemEnv` is set to `true` (default: **off**), `ocx start` uses `launchctl setenv`
to inject `ANTHROPIC_BASE_URL` and the related Claude Code environment variables system-wide.
New terminal windows and tabs therefore route plain `claude` commands through the proxy without
requiring the `ocx claude` wrapper. Already-open shells are unaffected and must be reopened.

`ocx stop` and proxy shutdown **unset the injected keys** (it does not restore previous values —
only the keys opencodex injected are removed). The proxy also writes `~/.opencodex/claude-env.sh`;
`ocx start` installs a `.zshrc` source hook that loads it automatically.

Disable with `claudeCode.systemEnv: false` in the configuration or with the GUI toggle. This
feature is macOS-only; on other platforms, use `ocx claude`.

## Native Claude passthrough (subscription pierce)

With no auth override set, Claude Code keeps its claude.ai OAuth login and sends it to the proxy.
Requests for genuine `claude*`/`anthropic*` models that no alias or model map claims are forwarded
**verbatim** to `api.anthropic.com` with your credential — betas, thinking signatures, prompt
caching and billing identity stay fully native, and routed models keep working in the same session
via the picker aliases.

**Header handling:** hop-by-hop headers plus `host`, `content-length`, `accept-encoding`,
`x-opencodex-api-key`, and `origin` are stripped before forwarding. All other headers (including
`anthropic-beta` and `anthropic-version`) pass through.

The passthrough fires when **all four** conditions are met: `nativePassthrough` is not `false`;
the model begins with `claude` or `anthropic`; the bearer or `x-api-key` starts with `sk-ant-`;
and alias/model-map resolution returns the same model unchanged. This also means the
"claude.ai connectors are disabled" warning no longer appears with `ocx claude`.

Disable with `claudeCode.nativePassthrough: false`; point elsewhere with
`claudeCode.anthropicBaseUrl`.

## The /model picker ("From gateway")

Claude Code 2.1.129+ discovers gateway models via `GET /v1/models?limit=1000` and lists them in
the native `/model` picker labeled "From gateway". Because the picker only accepts ids beginning
with `claude` or `anthropic`, opencodex exposes routed models as stable, reversible aliases:

| Surface | Format | Example |
| --- | --- | --- |
| Claude Code CLI | `claude-ocx-<provider>--<model>` | `claude-ocx-native--gpt-5.6-sol` |
| Claude Desktop 3P | `claude-opus-4-8-<code>` (3-char base36 hash) | `claude-opus-4-8-ncb` |

The proxy picks the family per request: `?ids=cli` or `?ids=desktop` wins; otherwise the
`claude-code/*` user-agent gets the readable CLI form and other clients get the Desktop hash.
Both families decode forever — a model saved in `settings.json` under either form keeps working.
Each entry carries an honest display name such as `gemini-3-pro (gemini)`, plus full model
capabilities (reasoning-effort ladder, thinking types) in the official ModelInfo shape so Claude
Desktop's third-party gateway mode can offer its effort selector. Real Anthropic models keep their
canonical ids. The synthetic 2026 date is an internal slot, not a release date. Legacy hash aliases
and `claude-ocx-<provider>--<model>` ids from older configs still resolve.
Models with an authoritative 1M context window get an extra `…[1m]` picker row: selecting it makes
Claude Code account a full 1M context for that model (auto-compaction stays on) — the proxy strips
the marker before routing.
Selecting one persists it to Claude Code's `settings.json` `model` field; inbound requests resolve
the alias back to the routed model. On older Claude Code versions the picker stays native — set
slots via
`ANTHROPIC_MODEL` or type any routed id with `/model` (Claude Code passes strings through).

**Alias grammar rules:** provider must not contain `/` or `--` or equal `native`; model must not
contain `/`. Routes the readable form cannot express fall back to the hashed alias. Model ids
MAY contain `--` (resolution splits on the first `--` only); native slugs containing `--` fall back to the hashed form.

**Model resolution order:** `[1m]` marker stripped → readable alias decoded → Desktop hashed
alias decoded → `modelMap` exact match → date-stripped match (`-20250514` removed) → passthrough.

Each entry carries a display name like `gemini-3-pro (gemini)`, plus full model capabilities
(reasoning-effort ladder, thinking types) in the official `ModelInfo` shape. Real Anthropic models
keep their canonical ids on both surfaces.

### Context-variant `[1m]` marker

Models with an authoritative context window of 1M (or, under auto-context, above 200k and at
least the compaction threshold) get an extra `…[1m]` picker row. Selecting it makes Claude Code
account a full 1M context. The proxy strips the case-insensitive `[1m]` suffix before alias
resolution and routing.

## Auto context (big-context models without the 200k ceiling)

Claude Code accounts 200k tokens for any model it does not recognize. **Auto context** (on by
default) fixes that:

1. Models whose real window is above 200k **and** at least the auto-compact threshold get the
   `[1m]` marker on their picker rows and env slots.
2. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (default `350000`, range `100000`–`1000000`) is injected so
   the conversation auto-summarizes at that point.

Three config states:

- **absent / `true`:** enabled (default)
- **`false`:** disabled — no markers, no compaction window injection
- **legacy `maxContextTokens` set:** auto-context is implicitly disabled

The compaction value is adjustable on the Claude page. **Warning:** raising it past a model's real
window breaks that model — the chat errors out before the summary can fire.

Sub-1M native Anthropic models are never auto-marked. Values you export yourself always win (the
proxy uses YOUR value to decide which models are safe to mark). Invalid hand-edited config values
fall back to 350k.

### Effective model environment

`effectiveModelEnv` computes six slots injected by `ocx claude` / system env / shell file:
`ANTHROPIC_MODEL`, four `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`, and legacy
`ANTHROPIC_SMALL_FAST_MODEL`. The effective Haiku is `tierModels.haiku ?? smallFastModel`, fed
to both Haiku variables.

## Roster agents (injectAgents)

`ocx claude` (and the system-env daemon) syncs your featured subagent roster (Subagents tab,
up to 5 models) plus `ocx-self` into `~/.claude/agents/ocx-*.md`.

- **`ocx-self`** pins your `/model` picker default (falling back to `claudeCode.model`); omitted
  when neither exists. It does NOT use model inheritance.
- Each agent body contains an `<!-- ocx-route: <model> -->` directive — the proxy uses this to
  pin the real route. The Agent tool's `model` argument is therefore inert; pass `"sonnet"` as a
  placeholder.
- Frontmatter carries the alias; routing is directive-driven.
- Only marker-verified `ocx-*.md` files containing `generated-by: opencodex` are ever
  overwritten or pruned; your own agents are never touched.
- Files are atomically synced per file (write + rename).
- `enabled: false` or `injectAgents: false` prunes all verified-owned definitions.
- GUI PUT and roster changes resync immediately; launcher/system-env sync at launch.

Dispatch: `subagent_type: "ocx-gpt-5-6-sol"`. 1M-capable targets carry `[1m]` automatically.

## Bundled-skill elision (blockedSkills)

Claude Code's bundled `claude-api` skill injects ~840KB (~136k tokens) of Anthropic documentation
that auto-triggers on Claude model mentions. Routed models are not trained on that bundle, so by
default opencodex replaces the skill's content with a short stub on **routed** requests. Native
Anthropic passthrough is untouched.

**Two carriers are handled:**

1. **Tool-result carrier:** assistant `Skill(...)` calls — the paired `tool_result` body is
   replaced by a stub when the lowercased JSON input contains a blocked name.
2. **Text-block carrier:** a user text block ≥10,000 characters starting with
   `Base directory for this skill: ` — matched when the directory basename equals a blocked name
   (case-insensitive).

Configure with `claudeCode.blockedSkills` (default `["claude-api"]`; `[]` disables elision
entirely). The stub keeps tool call/result pairing intact.

## Model map (interception)

`claudeCode.modelMap` rewrites inbound Anthropic model ids before routing:

```json
{
  "claudeCode": {
    "modelMap": {
      "claude-sonnet-4-5": "gemini/gemini-3-pro",
      "claude-haiku-4-5": "gemini/gemini-3-flash"
    }
  }
}
```

Lookup order: discovery alias → exact id → id with date suffix stripped (`-20250514`) → passthrough.

## Sidecar matrix: web search and image understanding

Routed models do not all have the same hosted tools or image support. opencodex fills those gaps
before the main model answers:

- The **web-search sidecar** runs the real hosted search, then gives the routed model the answer and
  sources as a tool result.
- The **vision sidecar** describes an attached image before calling a model listed in
  `noVisionModels`, then replaces the image with that description.

Both sidecars can use either backend:

| Backend | How it runs | What it requires |
| --- | --- | --- |
| `openai` | A small GPT model through the ChatGPT `forward` provider | A ChatGPT login and an enabled `authMode: "forward"` provider |
| `anthropic` | Claude through stored Anthropic OAuth; web search uses `web_search_20250305` and vision sends the image to Claude for description | An enabled `adapter: "anthropic"`, `authMode: "oauth"` provider whose active stored account is not marked `needsReauth` |

An explicit `backend` always wins. When it is omitted, opencodex selects `anthropic` if a usable
stored Anthropic OAuth account exists; otherwise it selects `openai`. Explicitly selecting
`anthropic` without a usable credential **fails closed**: opencodex does not silently borrow
ChatGPT credentials or switch backends. The OpenAI backend likewise stays off without both login
auth and a forward provider.

Claude-inbound routed replays attach the main ChatGPT login to the internal request, so OpenAI
sidecars remain reachable even though Claude Code's inbound bearer is only the proxy credential.
That bearer is never forwarded to the routed main provider.

```json
{
  "webSearchSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxSearchesPerTurn": 3
  },
  "visionSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxDescriptionsPerTurn": 8
  }
}
```

`maxDescriptionsPerTurn` limits new image descriptions in one main-model turn. Cache hits and
duplicate in-flight descriptions do not consume the cap. Successful descriptions for `data:`
images are cached by backend, model, detail, image bytes, and request context, so the same
image-and-context pair is not described again on every replay. Remote `https:` images are never
cached because their contents can change.

See the [configuration reference](/opencodex/reference/configuration/#sidecars) for every key.
Anthropic-OAuth web search and image description reuse the repository's existing Claude Code OAuth
fingerprint precedent, but should still be soak-tested with your account and workload before you
depend on them for long unattended runs.

<!-- TODO(WP5 GUI): Add the sidecar settings-screen walkthrough after the GUI controls ship. -->

## Reasoning effort

Claude Code's `/effort` setting is preserved across the adapter:

| Wire format | Mapping |
| --- | --- |
| `thinking.type: "adaptive"` + `output_config.effort` | Effort passed directly (`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`\|`ultra`) |
| `thinking.type: "enabled"` + `budget_tokens` | ≤4096→`low`, ≤16384→`medium`, above→`high` |
| `thinking.type: "disabled"` | Reasoning parameters omitted entirely |

The resolved value appears in the request log's **Reasoning effort** column.

## Inbound translation (Messages → Responses)

The proxy translates every Anthropic Messages API request into the Codex Responses API format:

| Messages input | Responses output |
| --- | --- |
| Top-level `system` | `instructions` (text blocks joined with `\n\n`) |
| `messages[].role: "system"` | Also folded into `instructions` |
| User text / image | `input_text` / `input_image` (base64 → data URL) |
| Assistant text | `output_text` |
| Assistant `tool_use` | `function_call` (`input` → JSON-stringified `arguments`) |
| User `tool_result` | `function_call_output` (`is_error` → `[tool error]` prefix) |
| `thinking` / `redacted_thinking` replay | Dropped |
| Function tools | `{type: "function"}` (`web_search*` → `{type: "web_search"}`) |
| `tool_choice` | `auto`→`auto`, `none`→`none`, `any`→`required`, named→`{type:"function",name}` |
| `max_tokens` | `max_output_tokens` |
| `stop_sequences` | `stop` |

**Error cases (400):** malformed JSON; missing/empty `model`; missing/empty `messages`; unsupported
role; `tool_result` without `tool_use_id`; `tool_use` without id/name; named `tool_choice` without
name.

## Outbound translation (Responses → Messages SSE)

| Responses event | Messages SSE |
| --- | --- |
| `response.created` | `message_start` + `ping` |
| Heartbeat | `ping` |
| Text deltas | `content_block_start` → `content_block_delta` (text) → `content_block_stop` |
| Reasoning summary/text | `thinking` block with synthetic signature |
| Function-call frames | `tool_use` block with `input_json_delta` |
| Terminal event | `message_delta` → `message_stop` |
| EOF before terminal | 502-style `api_error` |

**Stop reason mapping:** `completed` → `tool_use` (if any tool call) or `end_turn`;
`incomplete/max_output_tokens` → `max_tokens`; `incomplete/content_filter` → `refusal`.

**Error taxonomy:** 400 `invalid_request_error`, 401 `authentication_error`,
402 `billing_error`, 403 `permission_error`, 404 `not_found_error`, 409 `conflict_error`,
413 `request_too_large`, 429 `rate_limit_error`, 504 `timeout_error`, 529 `overloaded_error`,
other 5xx `api_error`. `Retry-After` is preserved.

## Prompt caching and token usage

**Anthropic-routed requests:** the adapter manages cache breakpoints for tools, system content,
and the penultimate user message, plus top-level automatic `cache_control`. Stable turns normally
produce about a 99.9% cache hit rate.

**Native OpenAI/ChatGPT routing:** derives a session-scoped `prompt_cache_key` (from
`metadata.user_id` when present, falling back to a system-content hash) and `session_id` header
for cache affinity. The cache key includes model and full tool schemas.

**Token math:** Anthropic output subtracts `cached_tokens` and `cache_write_tokens` from
`input_tokens`, exposing them as `cache_read_input_tokens` and `cache_creation_input_tokens`.
Request logs map those back to inclusive `inputTokens`, with reads in both `cachedInputTokens` and
`cacheReadInputTokens`, writes in `cacheCreationInputTokens`. The Usage page reports cache hits
and cache creation separately.

**count_tokens:** routed models use an approximation (serialized system + messages + tools).
Native Anthropic models with an `sk-ant-` credential pass the request through to the real
Anthropic `/v1/messages/count_tokens` endpoint.

## Debug capture

`ocx debug claude on|off|status|reset`, `OCX_CLAUDE_DEBUG=1`, or `PUT /api/debug {"claude": true}`
controls inbound capture. `GET /api/claude/inbound-debug` returns `{enabled, entries}` (newest
first, ring of 20).

Each entry records: `at`, `endpoint`, `model`, `resolvedModel`, `stream`, `maxTokens`,
`thinkingType`, `thinkingBudgetTokens`, `outputConfigEffort`, `metadataKeys`,
`hasMetadataUserId`, `hasSystem`, raw `anthropicBeta`, and eight-character HMAC equality tags for
user id / system. **No prompt text, raw object, or stable cross-run hash is stored.** Disabling
Claude debug immediately clears the ring.

## GUI (Claude page)

The dashboard sidebar has a dedicated **Claude** page (below API) and a **Claude ON** toggle
(label intentionally identical in every language). The page shows:

- Inbound kill switch (enabled toggle)
- Quickstart (`ocx claude`) and manual env block
- Fast Mode selector (Auto / ON / OFF)
- Auto-context toggle and compaction threshold dropdown
- Subagent auto-registration toggle
- Model interception (modelMap) editor
- Live preview of picker aliases

`GET /api/claude-code` returns effective defaults, config, context-window registry, effective env,
available route ids, aliases, and port. `PUT /api/claude-code` is partial and preserves omitted
fields; `null` resets context/blocklist/compact-window values.

## Troubleshooting

**Claude Code says "Did 0 searches"** — Current builds translate completed Responses
`web_search_call` items into paired Anthropic `server_tool_use` and `web_search_tool_result` blocks,
including `usage.server_tool_use.web_search_requests`. Update opencodex if an older build completed
the search but Claude Code still counted zero.

**A sidecar does not activate** — For `backend: "openai"`, confirm you are logged into ChatGPT and
have an enabled `authMode: "forward"` provider. For `backend: "anthropic"`, confirm the active stored
Anthropic OAuth account is not marked `needsReauth`. An explicit Anthropic selection without that
credential intentionally fails closed.

**"claude.ai connectors are disabled"** — An `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set
in your shell. `ocx claude` deliberately does NOT set `ANTHROPIC_API_KEY`; if you have it exported,
unset it. `ocx claude` injects `ANTHROPIC_BASE_URL`, discovery, auto-context, and configured model slots — but never `ANTHROPIC_API_KEY`.

**Models not showing in /model picker** — Verify `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` is
set (automatic with `ocx claude`). Run `ocx claude` to refresh the gateway model cache at
`~/.claude/cache/gateway-models.json`. Check `claudeCode.enabled` is not `false`.

**Stale environment after port change** — If the proxy port changed, old shells may have a stale
`ANTHROPIC_BASE_URL`. Open a new terminal, or re-run `ocx claude`.

**200k context ceiling despite big model** — Select the `[1m]` variant in the picker, or enable
auto-context (on by default). If the picker shows no `[1m]` row, the model's authoritative context
window may be below the auto-compact threshold.

**High token count from skill loads** — The bundled `claude-api` skill (~136k tokens) auto-loads
on Claude model mentions. This is normal for native passthrough; on routed models, opencodex stubs
it by default (`blockedSkills: ["claude-api"]`).

**Subagent dispatches to wrong model** — Roster agents (`ocx-*`) use `<!-- ocx-route: ... -->`
directives, not the Agent tool's `model` argument. Make sure the directive matches the intended
route. Pass `"sonnet"` as the model placeholder.
