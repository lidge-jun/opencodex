# 90.1 — Codex App Fast + Model Visibility

Date: 2026-06-20

## Outcome

The Phase 90 patch did more than fix the Codex TUI `/fast` status line. The user confirmed that
Codex App also:

- exposes the fast option for native OpenAI passthrough models, and
- shows opencodex routed model names in the model picker.

This is a major integration result because Codex App appears to consume the same Codex home
configuration and model catalog path as Codex CLI/TUI.

## Why it worked

opencodex is now aligned with Codex's native integration surfaces:

1. `model_provider = "opencodex"` is written at the TOML root, not inside a stale table.
2. `[model_providers.opencodex]` is shaped like a Codex Responses provider:
   - `base_url = "http://localhost:10100/v1"`
   - `wire_api = "responses"`
   - `requires_openai_auth = true`
3. `model_catalog_json` is also written at the TOML root, pointing Codex to
   `$CODEX_HOME/opencodex-catalog.json`.
4. Routed catalog entries are cloned from a native Codex model template, preserving strict parser
   fields such as `base_instructions`, `supported_reasoning_levels`, `shell_type`, and
   `supported_in_api`.
5. Routed entries set `slug`, `display_name`, `description`, `priority`, and `visibility = "list"`,
   making them picker-visible without Codex App-specific code.
6. Native OpenAI passthrough models keep fast-tier metadata, while routed provider models strip
   speed/service-tier metadata so fast does not leak to non-OpenAI providers.

## Important split

Current Codex uses different spellings for persistence vs runtime/catalog semantics:

- Config persistence: `service_tier = "fast"`
- Runtime/catalog service-tier id: `priority`
- UI feature gate: `[features].fast_mode = true`
- Account/provider gate: `requires_openai_auth = true`

opencodex must preserve this split. Rewriting everything to `fast` or everything to `priority`
breaks one side of Codex.

## Regression checks

Use these checks before claiming this path is still working:

```bash
codex debug models
```

Confirm native OpenAI passthrough models include fast support:

```text
gpt-5.5
additional_speed_tiers: ["fast"]
service_tiers: [{ id: "priority", name: "Fast" }]
```

Confirm routed models do not expose fast/service tiers:

```text
opencode-go/*
xai/*
anthropic/*
```

Expected:

```text
no additional_speed_tiers
no service_tier
no service_tiers
no default_service_tier
```

Also confirm the injected Codex config contains:

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
service_tier = "fast"

[features]
fast_mode = true

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://localhost:10100/v1"
wire_api = "responses"
requires_openai_auth = true
```

## Files

- `src/codex-inject.ts`
- `src/codex-catalog.ts`
- `src/codex-paths.ts`
- `src/server.ts`
