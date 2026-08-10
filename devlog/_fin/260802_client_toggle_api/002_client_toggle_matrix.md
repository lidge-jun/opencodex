# 002 — Per-client toggle requirements

Research only. No diffs here. Each section answers the same five questions from
000 Q2: where the config lives, the minimal provider block, hot-reload
semantics, non-interactive management surface, credential handling, and removal
cleanup. Lane findings were source-opened by the dispatched subagents; the main
agent re-opened the Hermes provider docs and the cc-switch writer modules in the
previous cycle (see 001). Snapshot date: 2026-08-02.

## Summary matrix

| | Hermes Agent | OpenClaw | Kimi Code CLI | Gajae Code |
|---|---|---|---|---|
| Config file | `~/.hermes/config.yaml` | `~/.openclaw/openclaw.json` | `~/.kimi-code/config.toml` | `~/.gjc/agent/models.yml` |
| Format | YAML | JSON5 | TOML | YAML |
| Dir override | `HERMES_HOME`; Windows `%LOCALAPPDATA%\hermes` | settings override only | `KIMI_CODE_HOME` | — |
| Hot reload | No (mtime-cached; new session) | **Yes** (gateway `hybrid` reload) | No in v1 (`/reload`); v2 watches | No (mtime refresh on `/model`/session start) |
| Env-ref for key | **Yes** (`${VAR}`, `${env:VAR}`) | **Yes** (`${VAR}`, SecretRef) | **No** (literal only) | **Yes** (`apiKeyEnv`, fail-closed) |
| Non-interactive add | No (wizard/dashboard only) | `openclaw config set/patch` | `kimi provider add <registry-url>` (registry import only) | `gjc setup provider` |
| Non-interactive remove | No | `openclaw config unset` | `kimi provider remove` (cascades) | **No** (file edit required) |
| Toggle channel of choice | file writer (or dashboard API) | **client CLI** | **registry endpoint + client CLI** | CLI add + file-writer remove |

## Hermes Agent

Upstream: `NousResearch/hermes-agent` `main`, 2026-08-02 (lane Dewey; main-agent
read of `website/docs/user-guide/configuring-models.md` in the earlier cycle).

- **Provider block** (modern dict form; legacy `custom_providers` list
  auto-migrates at config v12):
  `providers: <name>: { api: <base_url>, api_key, extra_headers,
  discover_models, models: [...] }`, with the active selection in
  `model: { provider, default, base_url, api_mode }`. `api_mode:
  chat_completions` targets the proxy's `/v1/chat/completions`.
- **Reload**: `hermes_cli/config.py` caches `config.yaml` by mtime/size and
  reloads only when `load_config()` runs. CLI chat reads at session start; the
  gateway has partial live reads. Treat provider changes as **new-session /
  restart required**.
- **Non-interactive surface**: `hermes setup --non-interactive` is a wizard,
  not provider CRUD. The dashboard is a local authenticated HTTP surface
  (`/api/config`, `/api/env`, `/api/model/set`, raw YAML save via
  `saveConfigRaw()` in `web/src/lib/api.ts` / `hermes_cli/web_server.py`) —
  usable for automation behind its session-token auth. A dedicated provider
  add/remove REST endpoint is **candidate — unverified** (none found).
- **Credentials**: `${VAR_NAME}` / `${env:VAR_NAME}` substitution is supported
  in provider config (`key_env`/`api_key_env` aliases also recognized), so the
  no-secret-serialization invariant survives. Undefined references remain
  verbatim with a warning.
- **Removal cleanup**: `~/.hermes/.env`, `auth.json`, credential-pool state,
  and sessions live outside `config.yaml`. Deleting our `providers:` entry
  leaves those intact; `hermes auth remove` handles credential-pool entries.
  A toggle that never writes credentials (env-ref only) has nothing extra to
  clean.

## OpenClaw

Upstream: `openclaw/openclaw` `main` + docs.openclaw.ai, 2026-08-02 (lane
Hegel).

- **Provider block**: `models.providers.<id>: { baseUrl, apiKey | SecretRef,
  auth, api, models: [{id, ...}], contextWindow, maxTokens, timeoutSeconds,
  params, headers }` ([src/config/types.models.ts#L199-L220](https://github.com/openclaw/openclaw/blob/main/src/config/types.models.ts#L199-L220)).
  Allowed `api` values include `openai-completions`, `openai-responses`,
  `anthropic-messages` ([types.models.ts#L11-L25](https://github.com/openclaw/openclaw/blob/main/src/config/types.models.ts#L11-L25)).
  `models.mode: "merge"` keeps the bundled catalog alongside ours; the default
  model is `agents.defaults.model.primary`.
- **Reload**: the gateway **watches `openclaw.json`**; default
  `gateway.reload.mode: hybrid` hot-applies model/provider changes
  ([config hot-reload](https://docs.openclaw.ai/configuration#config-hot-reload)).
  This is the one client where a file toggle takes effect on a running
  process — and therefore the one where non-atomic writes are most dangerous.
- **Non-interactive surface**: `openclaw config set` / `config patch` carry
  `--merge` for protected maps like `models.providers`; removal is a plain
  path unset, `openclaw config unset models.providers.opencodex` (`--merge` is
  not a documented unset flag), plus `openclaw models set <provider/model>`
  for the primary
  ([config CLI](https://docs.openclaw.ai/cli/config),
  [models CLI](https://docs.openclaw.ai/cli/models)). Full add/remove without
  touching the file ourselves. Exact path quoting and `--dry-run` behavior are
  implementation-cycle checks.
- **Credentials**: `${UPPERCASE_VAR}` interpolation in any config string,
  including `apiKey`; missing/empty variables fail config loading (fail-closed).
  SecretRef objects (`{ source: "env", ... }`) also supported
  ([env vars](https://docs.openclaw.ai/gateway/configuration#environment-variables)).
- **Removal cleanup**: plain `config unset models.providers.<id>` on our
  provider key; if the toggle set `agents.defaults.model.primary`, restore or
  clear it. No external credential state for an env-ref-only entry.

## Kimi Code CLI

Upstream: `MoonshotAI/kimi-code` `main` at `e22479a` (2026-08-01) + official
docs (lane Mencius; all findings source-verified).

- **Provider block** (`config.toml`):
  `[providers.opencodex] type = "openai"`, `base_url`, `api_key`; models as
  `[models.<alias>]` with **mandatory** `provider`, `model`, positive
  `max_context_size`, plus additive `capabilities`.
- **Capability inference is wire-scoped**: for `type = "openai"` only
  OpenAI-style prefixes (`oN`, `gpt-*`) are recognized, so a routed id like
  `anthropic/claude-opus-4-8` resolves to *unknown* capabilities and must be
  declared explicitly ([capability-registry.ts#L24-L44](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/kosong/src/providers/capability-registry.ts#L24-L44)).
  This collides with our "never guess metadata" invariant: the toggle should
  either emit only capabilities the catalog actually asserts, or omit the
  field and let the user declare it.
- **Reload**: v1 (default CLI) does **not** watch the file — `/reload` or
  restart. Experimental v2 (`KIMI_CODE_EXPERIMENTAL_FLAG=1`, `kimi web`)
  installs a watcher.
- **Non-interactive surface**: `kimi provider add <registry-url>
  --api-key <key>` imports a **custom `api.json` registry** — the CLI then
  creates the provider/model entries itself and refreshes them from the same
  URL on later startups. `kimi provider remove <id>` cascades: provider +
  referencing model aliases + `default_model`/`default_provider`
  ([core-impl.ts#L734-L762](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/agent-core/src/rpc/core-impl.ts#L734-L762)).
  There is **no** generic `kimi provider add --type openai ...`; a local proxy
  must be hand-written to TOML *or* served as a registry. **Design
  consequence: opencodex could serve an `api.json` registry endpoint, making
  the toggle `kimi provider add http://127.0.0.1:10100/...` / `kimi provider
  remove opencodex` — vendor-owned writes, atomic by construction, with
  cascade cleanup and catalog refresh for free.** The registry schema itself
  is an open question for the implementation cycle.
- **Write semantics**: provider mutations rewrite the *entire* TOML via
  `smol-toml` (unknown fields preserved as values; **comments and formatting
  lost**) ([toml.ts#L466-L517](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/agent-core/src/config/toml.ts#L466-L517)).
  An external writer can do no worse than the vendor's own CLI — but using the
  CLI/registry path avoids the fight entirely.
- **Credentials**: literal-only (no shell-env fallback). Loopback binds need
  no real key, so a placeholder satisfies the no-secret invariant; a
  non-loopback toggle would have to serialize a real key — scope the toggle
  to loopback or require manual key entry.
- **Removal cleanup**: CLI removal cascades config references; sessions and
  OAuth files are separate and untouched. An env-less custom provider has no
  extra auth state.

## Gajae Code

Upstream: published `gajae-code@0.12.7` / `@gajae-code/coding-agent@0.12.7`
tarballs, matching commit `5f2e7cd` (lane Kant; all findings source-verified).

- **Provider block** (`~/.gjc/agent/models.yml`): the Pi `models.json` shape
  in YAML — `providers.<id>: { baseUrl, apiKey | apiKeyEnv, api,
  models: [{id, name?, input, contextWindow?, maxTokens?}] }`. Allowed `api`
  values include `openai-completions` and `openai-responses`
  ([models-config-schema.ts#L113-L155](https://github.com/Yeachan-Heo/gajae-code/blob/5f2e7cd05e8ea344991566f9ed96f1f9c66226bd/packages/coding-agent/src/config/models-config-schema.ts#L113-L155)).
  **Validation is strict: unknown fields fail.** Our writer must emit only
  schema-known fields — the opposite of the preserve-everything default.
- **Reload**: `ModelRegistry` loads at construction; `refresh()` /
  `refreshInBackground()` compare mtime. No `fs.watch`. Opening `/model`
  triggers an offline refresh; session start schedules a background one.
  Toggle applies on new session or explicit refresh.
- **Credentials**: `apiKey` is *env-name-or-literal* (env lookup first, then
  the literal text becomes the token — a footgun); **`apiKeyEnv` is
  env-name-only and fail-closed — the field a toggle must use.**
  Credential order: runtime `--api-key` > `models.yml` key > stored `agent.db`
  credential > OAuth > standard env mapping > registry fallback
  ([auth-storage.ts#L3544-L3600](https://github.com/Yeachan-Heo/gajae-code/blob/5f2e7cd05e8ea344991566f9ed96f1f9c66226bd/packages/ai/src/auth-storage.ts#L3544-L3600)).
- **Non-interactive surface**: `gjc setup provider --compat openai|anthropic
  --provider ID --base-url URL --api-key-env ENV --model ID...
  [--force] [--json]` — add/replace only; raw `--api-key` is rejected by
  design ([setup-cli.ts#L332-L382](https://github.com/Yeachan-Heo/gajae-code/blob/5f2e7cd05e8ea344991566f9ed96f1f9c66226bd/packages/coding-agent/src/cli/setup-cli.ts#L332-L382)).
  Two gaps: custom `--compat openai` writes `api: openai-responses` with no
  `--api` selector (a chat-completions-only provider still needs direct YAML),
  and **no remove command exists** — removal is an atomic `models.yml` edit.
- **Removal cleanup**: `agent.db` credentials only exist if the user went
  through `/login`/broker (an env-backed toggle never creates them);
  references in `config.yml` (`modelRoles`, `enabledModels`,
  `disabledProviders`, `modelProviderOrder`, `modelProfile.default`) must be
  reverted if the toggle set them; live sessions keep their selected model
  until switched/restarted. The `models.db` discovery-cache row is inert for a
  removed provider.

## Cross-client observations

1. **Three of four clients offer a vendor-owned write path** (OpenClaw CLI,
   Kimi registry+CLI, Gajae add-CLI). Only Hermes forces a raw file write (or
   its dashboard API). Delegating writes to the vendor's own tool inherits
   their atomicity and schema knowledge; the cost is a version/availability
   dependency on their CLI.
2. **Only OpenClaw hot-reloads.** Every other client applies the toggle on
   the next session (Hermes, Gajae) or explicit `/reload` (Kimi v1). The GUI
  copy must say "applies to new sessions" everywhere except OpenClaw.
3. **The no-secret invariant survives everywhere except non-loopback Kimi.**
   Hermes `${VAR}`, OpenClaw `${VAR}`/SecretRef, and Gajae `apiKeyEnv` all
   carry env references; loopback needs no real key anywhere
   (`resolveApiAuth` skips admission on loopback binds).
4. **Removal asymmetry is the norm**: add is easy everywhere; clean remove
   needs a file writer for Hermes and Gajae, while OpenClaw and Kimi cascade
   through their CLIs.
