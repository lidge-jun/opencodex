# Antigravity effort-based model routing

> Date: 2026-07-22
> Unit: `devlog/_plan/260722_antigravity_effort_routing/`
> Mode: HOTL multi-cycle, docs-first Phase 0
> Class: C3 (cross-module: provider models, registry, adapter, tests)

## Loop spec

- Archetype: spec-satisfaction repair — the verifier defines done.
- Trigger: user request to collapse effort-variant model IDs into single picker entries with server-side effort routing.
- Goal: `gemini-3.6-flash` and `gemini-3.1-pro` appear as single picker entries with reasoning effort; the server routes effort to the correct CCA wire model ID. `claude-opus-4-6-thinking` gains effort control via `thinkingConfig` (Anthropic API + CLIProxyAPI verified). Suffix/compat IDs suppress `thinkingConfig` to avoid contradictory requests.
- Non-goals: Claude Sonnet effort control (no thinking model), gpt-oss effort control (single model), saved-config migration, push/release.
- Verifier: `bun run typecheck` + focused `bun test` on antigravity wire/listing/replay/registry-parity tests.
- Stop condition: all work-phase criteria met with fresh evidence.
- Memory artifact: this folder, `.codexclaw/goalplans/antigravity-effort-gemini-3-6-flash-gemini-3-1-p/`.
- Terminal outcomes: `DONE`, `NOOP`, `BLOCKED`, `NEEDS_HUMAN`.
- Escalation: main session reclaims after two failed delegated packets.

## Problem

The CCA (Cloud Code Assist) backend does not accept `thinkingConfig` — it encodes thinking level in the wire model ID (`gemini-3.6-flash-low`, `-medium`, `-high`). OCX currently exposes these as separate picker entries, which is noisy and confusing. The direct Google AI path already collapses `gemini-3.6-flash` into one entry and passes `thinkingConfig: { thinkingLevel }` in `generationConfig`, but this path is explicitly disabled for `cloud-code-assist` mode (google.ts:229-233).

## Direction locked by the user

- Collapse effort variants into single picker entries.
- Server-side effort → wire model routing.
- Claude/gpt-oss remain single models (no effort control).
- Existing suffix IDs survive as compatibility aliases.

## Dependency-ordered work-phase map

| WP | Document | Outcome | Dependency |
|---|---|---|---|
| WP0 | this roadmap + `001_research.md` + `010_models.md` + `020_adapter.md` | diff-level docs locked | current tree + external verification |
| WP1 | `010_models.md` | effort map in antigravity-models.ts + registry.ts | WP0 docs locked |
| WP2 | `020_adapter.md` | CCA buildRequest effort resolution | WP1 landed |
| WP3 | `030_tests.md` (written at WP2 D) | focused tests + typecheck pass | WP2 landed |

## Scope boundary

### In

- `src/providers/antigravity-models.ts` — effort map, collapsed picker, compat aliases
- `src/providers/registry.ts` — `modelReasoningEfforts` for google-antigravity (no `modelReasoningEffortMap` needed — identity labels are preserved by `mapReasoningEffort`)
- `src/adapters/google.ts` — CCA buildRequest effort resolution + thinkingConfig for CCA; suffix-ID precedence suppresses thinkingConfig
- `tests/google-antigravity-wire.test.ts`, `tests/google-models-listing.test.ts` — fixtures
- `tests/reasoning-effort.test.ts` — resolver unit tests
- `tests/usage-cost.test.ts` — updated overlay count and base-ID price entries
- `tests/provider-registry-parity.test.ts` — parity
- `tests/google-antigravity-replay.test.ts` — replay cache key isolation per effort level

### Out

- Claude Sonnet effort control (no thinking model to adjust)
- gpt-oss-120b-medium effort control (single model)
- Saved-config migration (compat aliases handle it)
- Push, release, deploy
- GUI picker changes (Providers.tsx only holds the provider label; model metadata comes from the registry/catalog, which this plan already covers)

## Cross-cutting invariants

- Registry is the preset source of truth: `registry.ts` → `derive.ts` → CLI/GUI.
- Inbound aliases survive picker retirement unless a separate migration contract exists.
- Replay cache keys use the resolved wire model ID, not the picker alias.
- No credential or token response body is logged.
