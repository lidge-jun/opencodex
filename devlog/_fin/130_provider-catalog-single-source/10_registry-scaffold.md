# 130.10 — Registry Scaffold

## Purpose

Phase 130 replaces provider information copied across the GUI, CLI init menu, OAuth seeds,
key-login catalog, and jawcode metadata generator with a single canonical registry.

The scaffold work introduced two modules:

| File | Role |
|------|------|
| `src/providers/registry.ts` | Canonical provider rows and provider metadata types. |
| `src/providers/derive.ts` | Projection helpers used by existing consumers. |

## Registry shape

`ProviderRegistryEntry` captures the fields that were previously spread across several modules:

| Field | Why it exists |
|-------|---------------|
| `id` | Stable provider config key and GUI/CLI identifier. |
| `label` | Human-facing provider name. |
| `adapter` | Canonical adapter string. |
| `baseUrl` | Default endpoint seed. |
| `authKind` | One of `forward`, `oauth`, `key`, or `local`. |
| `featured` | Marks the current 13 GUI quick-pick providers. |
| `dashboardUrl` | API-key login destination. |
| `defaultModel`, `models`, `noVisionModels`, `noReasoningModels` | Provider seed and routing metadata. |
| `oauthId` | OAuth handler key when it differs from `id`. |
| `jawcodeBundle`, `extraMetadataAliases` | Bundled metadata alias source. |
| `metadataModelIdNormalize` | Per-provider metadata lookup normalization policy. |

## Canonical decisions encoded

| Topic | Registry value |
|-------|----------------|
| Azure | `azure-openai` is the canonical adapter string. |
| Legacy Azure | `azure` is not authored in the registry; it is handled as a server compatibility alias. |
| Kimi OAuth | `https://api.kimi.com/coding/v1`. |
| Moonshot API key | Separate `moonshot` row using `https://api.moonshot.ai/v1`. |
| Anthropic default | `claude-sonnet-4-6`. |
| Local providers | `authKind: "local"` for `ollama`, `vllm`, and `lm-studio`. |
| MiniMax metadata | `minimax` and `minimax-cn` share `jawcodeBundle: "minimax"` and use case-insensitive metadata fallback. |
| Google alias | `google` owns the row; `gemini` remains a metadata alias only. |

## Projection helpers

`src/providers/derive.ts` exposes small, typed projections instead of one large omniscient API:

| Helper | Consumer |
|--------|----------|
| `deriveKeyLoginMap()` | `KEY_LOGIN_PROVIDERS` compatibility export and `/api/key-providers`. |
| `deriveInitProviders()` | `ocx init` provider menu. |
| `deriveOAuthProviderConfig()` | OAuth provider config seeds. |
| `deriveOAuthDefaultModel()` | OAuth default model fields. |
| `deriveProviderPresets()` | GUI add-provider picker via `/api/provider-presets`. |
| `deriveFeaturedProviderIds()` | Parity test guard for the current featured set. |
| `deriveJawcodeAliases()` | Metadata generator alias map. |
| `shouldCaseFoldMetadataModelId()` | Catalog metadata fallback for MiniMax casing. |

## Boundary notes

The GUI does not import `src/providers/*` directly. The plan audit found that the GUI is a
standalone Vite package scoped to `gui/src`, so the server owns the projection and the GUI reads
it at runtime through `/api/provider-presets`.

The registry is TypeScript rather than JSON because the current provider rows benefit from typed
unions and comments. A later codegen step can export JSON if external tooling needs it.
