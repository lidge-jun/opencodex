# Gemini 3.6 Flash rollout plan

- Date: 2026-07-22
- Branch: `gemini-3.6`
- Work class: C3 — provider catalog, wire routing, persisted OAuth presets, usage pricing, and tests move together.
- Status: P complete as a docs-only handoff. No runtime implementation has started.

## Loop spec

- Archetype: satisfy-spec integration.
- Trigger: Google released `gemini-3.6-flash` as GA on 2026-07-21, while authenticated Antigravity discovery simultaneously began returning 3.6-specific wire IDs.
- Goal: make Gemini 3.6 selectable and correctly routed without erasing still-supported Gemini 3.5 outside Antigravity.
- Non-goals: Vertex AI promotion, Cursor/OrcaRouter/OpenRouter speculative seeding, a global Gemini sampling-parameter migration, manual edits to generated jawcode metadata, or changing the direct Google provider's default model.
- Verifier: focused provider/adapter/catalog/usage tests, `bun run typecheck`, authenticated Antigravity discovery, and one minimal live request per newly exposed Antigravity tier after `ocx restart`.
- Stop condition: the static/runtime catalogs match the surface matrix below, old Antigravity selections migrate without remaining visible, all focused tests and typecheck pass, and each new Antigravity tier returns a valid response.
- Memory artifact: this unit folder. C/D evidence is appended here before moving the folder to `devlog/_fin/`.
- Expected terminal outcomes: `DONE`, `BLOCKED` when upstream removes or rejects a discovered ID, or `NEEDS_HUMAN` when live verification would require an unavailable Google API credential.
- Escalation: no delegation is planned. If implementation is delegated later, that is a P-phase amendment; after two failed worker packets the main session reclaims the slice.

## User direction translated into surface rules

| Surface | Current 3.5 state | Gemini 3.6 decision |
|---|---|---|
| `google-antigravity` OAuth | 3.5 Low/Medium/High are exposed through mixed wire IDs and aliases | Replace visible 3.5 rows with explicit 3.6 Low/Medium/High wire IDs. Keep old 3.5 IDs only as hidden inbound compatibility aliases. |
| `google` API key | `gemini-3.5-flash` is the default and `gemini-3.1-pro-preview` is also seeded | Add `gemini-3.6-flash`; retain 3.5 and keep 3.5 as default. |
| Cursor | Current authenticated catalog contains 3.5 but not 3.6 | No static addition until Cursor advertises 3.6. |
| OrcaRouter | Static seed contains `google/gemini-3.5-flash`; the 3.6 model page currently returns 404 | No addition until OrcaRouter advertises the exact ID. |
| Generated jawcode snapshot | Source and generated files contain 3.5 but not 3.6 | Do not hand-edit generated output. Use registry hints and a verified local price overlay until jawcode gains the row. |

## Fixed decisions

1. Antigravity exposes `gemini-3.6-flash-low`, `gemini-3.6-flash-medium`, and `gemini-3.6-flash-high`.
2. `gemini-3.6-flash-tiered` remains hidden because authenticated discovery returns no display name and the visible Antigravity choices already have explicit tier IDs.
3. The Antigravity default becomes `gemini-3.6-flash-medium`. This preserves the effective current default: the existing `gemini-3.5-flash-low` wire row is displayed upstream as “Gemini 3.5 Flash (Medium).”
4. Hidden compatibility mappings preserve old selections:
   - `gemini-3.5-flash-extra-low` -> `gemini-3.6-flash-low`
   - `gemini-3.5-flash-low` and `gemini-3.5-flash-mid` -> `gemini-3.6-flash-medium`
   - `gemini-3.5-flash-high` and `gemini-3-flash-agent` -> `gemini-3.6-flash-high`
5. Direct Google keeps `gemini-3.5-flash` as default. “Add elsewhere” does not silently change existing API-key users' default.
6. Direct Google 3.6 advertises the repository's Codex-facing `low`/`medium`/`high` ladder and sends the selected level as Gemini `generationConfig.thinkingConfig.thinkingLevel`. The existing 3.5 path receives the same missing wire fix so the new model does not copy a catalog-only effort control.
7. Deprecated `temperature`, `top_p`, and `top_k` are not removed in this slice. Google marks them deprecated, not rejected; changing global request shaping needs separate compatibility evidence.

## Scope

### IN

- Antigravity visible model replacement plus hidden compatibility aliases.
- Direct Google 3.6 static model, context, image-input, and reasoning metadata.
- Direct Google 3.5/3.6 thinking-level request wiring.
- Gemini 3.6 public-list-price and Antigravity-derived usage overlays.
- Existing-config reconciliation and regression tests.
- Fresh runtime proof after implementation and daemon restart.

### OUT

- Vertex AI: Gemini Developer API evidence does not prove Vertex publisher availability.
- Cursor: authenticated current list has no 3.6 row.
- OrcaRouter: exact 3.6 model page is absent.
- OpenRouter: dynamic catalog owns exposure; no 3.5 static seed is being replaced here.
- `src/generated/jawcode-model-metadata.ts`: generated file, and its current source has no Gemini 3.6 row.
- Benchmark fixtures and docs-site benchmark data: historical measurements are not model availability declarations.

## Dependency-ordered work-phase map

| Phase | Document | Outcome |
|---|---|---|
| 0 — Research and contract lock | `001_research_contract.md` | Official API contract, authenticated Antigravity IDs, and exclusions are durable. |
| 1 — Catalog, wire, migration, and verification | `010_model_catalog_and_wire_plan.md` | One coherent implementation slice updates runtime owners, compatibility, prices, tests, and live proof. |

## Acceptance criteria

- `google-antigravity` lists only 3.6 Low/Medium/High for the Flash family; no 3.5 Flash row or `gemini-3-flash-agent` remains picker-visible.
- Routing an old 3.5 Antigravity ID emits the corresponding 3.6 wire ID, while fresh 3.6 IDs pass through unchanged.
- A persisted OAuth config whose default is `gemini-3.5-flash-low` reconciles to `gemini-3.6-flash-medium` on startup without touching credentials or unrelated provider settings.
- Direct `google` lists `gemini-3.6-flash`, `gemini-3.5-flash`, and `gemini-3.1-pro-preview`; the default remains `gemini-3.5-flash`.
- Direct 3.6 catalog metadata reports 1,048,576 context, image input, and low/medium/high reasoning choices.
- Activation scenario for effort wiring: a direct Google 3.6 request with `reasoning: "high"` contains `generationConfig.thinkingConfig.thinkingLevel = "high"`; an unset effort omits `thinkingConfig`.
- Usage resolution returns the verified 3.6 public price for direct Google and derived prices for all three Antigravity tiers, with no retired 3.5 Antigravity overlay left.
- Cursor and OrcaRouter remain unchanged.
- Focused tests and typecheck pass; after `ocx restart`, all three 3.6 Antigravity tiers complete a minimal live prompt.

## Risks and rollback

- Upstream Antigravity IDs may change without announcement. The authenticated `fetchAvailableModels` list is the verifier; a missing ID blocks live completion rather than triggering guessed aliases.
- Hiding old IDs without compatibility aliases would break saved combos or manually selected slugs. Compatibility aliases are therefore separated from picker exposure.
- A live request can consume account quota. Verification uses one minimal prompt per tier and records only status/model identity, never OAuth tokens or raw credential payloads.
- Rollback restores the old Antigravity visible list/default, removes the direct 3.6 seed and overlays, and reverts the focused tests. No persistent data migration is introduced.
