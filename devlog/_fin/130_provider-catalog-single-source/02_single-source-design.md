# 130.02 — Single-Source Provider Registry Design

Planning spec for replacing the three hand-maintained catalogs with **one canonical registry**
and derived views. Implements the parity contract in `init.ts:33-36` mechanically instead of
by comment.

## Goals

| Goal | Metric |
|------|--------|
| **Single authoring surface** | Adding a provider = one registry row (+ optional jawcode bundle pointer) |
| **Derived consumers** | GUI presets, `KEY_LOGIN_PROVIDERS`, `buildInitProviders`, metadata aliases generated or asserted — not copied |
| **Drift impossible in CI** | Test fails if any consumer set ≠ registry projection |
| **Incremental migration** | No big-bang; legacy exports remain during transition |
| **Metadata correctness** | Alias map + **normalized model-id lookup** (casing) |

Non-goals: changing jawcode `models.json`; auto-adding metadata for all 31 key-login providers
(initial bundle set stays curated).

## Canonical registry

### Location

```
src/providers/registry.ts          ← authoring surface (TypeScript for types + comments)
src/providers/derive.ts            ← runtime projections for CLI/API/OAuth/metadata
```

Keep the registry **under `src/providers/`** (not `gui/`) so CLI, server, OAuth, and
`scripts/generate-jawcode-metadata.ts` can import it directly. The GUI is a standalone Vite
package scoped to `gui/src`, so it must consume a server projection (`GET /api/provider-presets`)
instead of importing repo-root `src/providers/*` at build time.

Alternative considered: JSON (`providers.json`) — rejected for phase 1 because entries need
inline comments (dashboard URLs, exclusion rationale mirroring `key-providers.ts:66-69`) and
typed `authKind` unions. JSON + JSONC is a follow-up if non-TS editors need access.

### Row shape (`ProviderRegistryEntry`)

```ts
/** One logical provider id across all surfaces. */
export interface ProviderRegistryEntry {
  id: string;                    // config key, e.g. "opencode-go"
  label: string;
  adapter: string;               // canonical adapter string (resolve azure vs azure-openai here)
  baseUrl: string;
  authKind: "forward" | "oauth" | "key" | "local";

  /** GUI quick-pick: show in static preset list (not only search catalog). */
  featured?: boolean;

  /** API-key flow: dashboard link. */
  dashboardUrl?: string;

  defaultModel?: string;
  models?: string[];
  noVisionModels?: string[];
  noReasoningModels?: string[];

  /** OAuth registry key when authKind === "oauth" (usually same as id). */
  oauthId?: string;

  /** Bundled jawcode metadata: jawcode bundle id in models.json (e.g. minimax-cn → "minimax"). */
  jawcodeBundle?: string;

  /**
   * Optional normalizer for metadata lookup when live /models ids differ from jawcode ids
   * (minimax CamelCase vs lowercase). Applied in applyJawcodeCatalogMetadata before getJawcodeModelMetadata.
   */
  metadataModelIdNormalize?: "case-insensitive";
}
```

**Design rules**

1. **`id` is unique** — the config `providers.<id>` key everywhere.
2. **`adapter` is canonical** — pick one string per provider (`azure` vs `azure-openai` decided
   once; GUI adapter dropdown may map display labels separately).
3. **`authKind` drives init menu grouping** (`init.ts:64-69` `KIND_HEADING`) and GUI badges
   (`AddProviderModal.tsx:220-224`).
4. **`featured: true`** replaces duplicate static `PRESETS` rows — quick-pick is a **filter**, not
   a second list.
5. **`jawcodeBundle`** replaces `PROVIDER_ALIASES` manual duplication; unset = no bundled metadata.

### Registry segments (replaces today's assembly)

| Segment | authKind | Example ids | Replaces |
|---------|----------|-------------|----------|
| Forward | `forward` | `openai` | `init.ts:41`, `PRESETS :30` |
| OAuth | `oauth` | `xai`, `anthropic`, `kimi` | `OAUTH_PROVIDERS` providerConfig seeds + GUI oauth presets |
| Featured key | `key`, `featured: true` | `openai-apikey`, `opencode-go`, `openrouter`, … | `init.ts:48-52`, static `PRESETS` |
| Key catalog | `key` | `deepseek`, `mistral`, … | `KEY_LOGIN_PROVIDERS` |
| Local | `local` | `ollama`, `vllm`, `lm-studio` | `init.ts:58-60`, `PRESETS :40-42` |

OAuth **login/refresh implementations** stay in `src/oauth/*.ts` — the registry only holds
static providerConfig seeds; `OAUTH_PROVIDERS` becomes a thin map of handlers keyed by `oauthId`.

## Per-consumer derivation

### 1 — GUI (`AddProviderModal.tsx`)

**Target behavior:** the server exposes a registry-derived `GET /api/provider-presets` endpoint,
and the GUI uses that runtime shape for the add-provider picker. This keeps the standalone GUI
package isolated from repo-root TypeScript while still removing the hardcoded `PRESETS` list.

Merge logic (`allPresets` `:94-100`) becomes unnecessary because the endpoint returns the final
selectable list: `featured + key catalog − duplicates + custom`.

**OAuth presets:** derive from `authKind === "oauth"` rows; `oauthProvider` = `oauthId ?? id`.
**Fixes live mismatches** by reading single `baseUrl` / `defaultModel` for `kimi` and `anthropic`.

### 2 — CLI init (`buildInitProviders`)

Replace manual assembly (`init.ts:38-61`) with:

```ts
export function buildInitProviders(): InitProvider[] {
  return REGISTRY.map(row => ({
    id: row.id,
    label: formatInitLabel(row),   // centralizes "— account login" / "— API key" suffixes
    adapter: row.adapter,
    baseUrl: row.baseUrl,
    kind: row.authKind,
    dashboardUrl: row.dashboardUrl,
    defaultModel: row.defaultModel,
  }));
}
```

`enrichProviderFromCatalog` reads the same registry slice as key-login rows (not a separate map).

### 3 — `KEY_LOGIN_PROVIDERS` export

During migration, keep export shape:

```ts
export const KEY_LOGIN_PROVIDERS = deriveKeyLoginMap(REGISTRY);
```

`listKeyLoginProviders()` unchanged for `/api/key-providers`.

### 4 — Metadata aliases (`generate-jawcode-metadata.ts`)

Replace hand-written `PROVIDER_ALIASES` with registry-driven generation:

```ts
const PROVIDER_ALIASES = deriveJawcodeAliases(REGISTRY);
// { [opencodexId]: jawcodeBundle } for rows where jawcodeBundle is set
```

`allowedProviders = unique(jawcodeBundle values)` — same as today (`:34`).

Generation script imports `REGISTRY` from `src/providers/registry.ts` (Bun/Node compatible).

### 5 — Catalog metadata application (`codex-catalog.ts`)

Extend `applyJawcodeCatalogMetadata` (`:90-99`):

1. `resolveJawcodeProvider(provider)` — still alias map (generated from registry).
2. **New:** `normalizeModelId(provider, modelId)` using registry row's
   `metadataModelIdNormalize` before `getJawcodeModelMetadata`.
3. For minimax: try exact id, then case-insensitive match against bundle rows, or map known
   lowercase patterns (`minimax-m2.5` → `MiniMax-M2.5`).

This addresses the casing fragility independent of jawcode id renames.

## Incremental migration (no big-bang)

| Step | Work | Risk | Rollback |
|------|------|------|----------|
| **M1 — Registry scaffold** | Add `registry.ts` with all 43+ rows transcribed from current sources; **no consumer changes** | Low | Delete new files |
| **M2 — Drift guard (read-only)** | Test compares registry projections to legacy exports; **fails on current mismatches** until M3 fixes fields | None (test-only) | Skip test in CI temporarily |
| **M3 — Wire CLI + API** | `KEY_LOGIN_PROVIDERS`, `buildInitProviders`, `/api/key-providers` import derived maps; fix `kimi`/`anthropic`/`azure-openai` fields in registry | Medium | Revert imports |
| **M4 — Wire GUI** | Replace static `PRESETS` with `/api/provider-presets`; keep a minimal custom fallback if the proxy request fails | Medium UI | Revert component |
| **M5 — Metadata pipeline** | Generator reads `jawcodeBundle` from registry; add model-id normalizer in `codex-catalog.ts` | Medium catalog | Regenerate old metadata |
| **M6 — Delete duplicates** | Remove hardcoded `init.ts:48-52` block comments; strip legacy alias object from generator | Low | — |

**Order rationale:** M2 runs early so transcribing the registry **forces** resolving known field
mismatches before wiring consumers. BUG A/B hotfixes are already in legacy sources — M1 copies
them into registry as the golden row values.

## CI / drift-guard test

**File:** `tests/provider-registry-parity.test.ts` (or extend existing bun test suite).

```ts
import { REGISTRY } from "../src/providers/registry";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { buildInitProviders } from "../src/init";
import { deriveFeaturedIds, deriveJawcodeAliases } from "../src/providers/derive";
import PRESETS from "../gui/..."; // or import derived featured after M4

describe("provider registry parity", () => {
  it("KEY_LOGIN matches registry key rows", () => {
    const fromRegistry = deriveKeyLoginMap(REGISTRY);
    expect(fromRegistry).toEqual(KEY_LOGIN_PROVIDERS);
  });

  it("buildInitProviders matches registry init projection", () => {
    const fromRegistry = deriveInitProviders(REGISTRY);
    const legacy = buildInitProviders();
    expect(fromRegistry.map(p => p.id)).toEqual(legacy.map(p => p.id));
    // field-deep equal after M3 field fixes
  });

  it("metadata aliases match registry jawcodeBundle fields", () => {
    expect(deriveJawcodeAliases(REGISTRY)).toEqual(readGeneratedAliases());
  });

  it("featured GUI ids are a registry projection", () => {
    expect(deriveProviderPresets().map(p => p.id).at(-1)).toBe("custom");
    expect(new Set(deriveFeaturedIds(REGISTRY))).toEqual(new Set(EXPECTED_FEATURED_IDS));
  });
});
```

**CI gate:** `bun test tests/provider-registry-parity.test.ts` in default `bun test` — zero
drift tolerance once M3 lands. During M1–M2, test may be `describe.skip` with a tracking issue
or assert only id sets until field fixes land.

**Optional stricter guard:** codegen `src/providers/registry.snapshot.json` from REGISTRY in CI
and fail if registry changes without snapshot update (prevents drive-by edits).

## Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Model-id casing** (`MiniMax-M2.5` vs `minimax-m2.5`) | `getJawcodeModelMetadata` no-op (`jawcode-model-metadata.ts:42-43`); missing `context_window` / modalities in Codex catalog | Registry `metadataModelIdNormalize` + fallback lookup in `applyJawcodeCatalogMetadata` (`codex-catalog.ts:90-99`) |
| **jawcode provider naming** (`minimax-code*` vs `minimax-cn`) | Wrong bundle if alias points to mismatched jawcode key | `jawcodeBundle` explicit per row; document mapping in registry comment |
| **OAuth vs API-key endpoint splits** (`kimi` oauth vs `moonshot` key-login) | User confusion if merged incorrectly | Keep **separate registry rows** with distinct ids; single-source does not mean single endpoint |
| **GUI bundle size** | Importing full registry + 31 rows into GUI | Tree-shake derive functions; registry is small (&lt;50 rows) |
| **Azure adapter string** (`azure` vs `azure-openai`) | Existing configs use one spelling | Pick canonical in registry; migration note + adapter alias in router if needed |
| **Third-party docs** cite `key-providers.ts` | Contributor docs stale | Update `docs-site/.../contributing.md` in M3 (out of scope for 130 planning cycle) |
| **Runtime `/api/key-providers`** consumers | External tools parsing API | Keep endpoint; implementation reads registry |

## Success criteria (implementation phase, post-130)

1. Adding a provider = **one registry row** + `bun test` green + regenerate metadata if
   `jawcodeBundle` set.
2. `buildInitProviders().map(p => p.id)` equals GUI selectable ids (proxy off) for all non-custom
   providers.
3. BUG A/B scenarios covered by parity test: id in `featured` or key catalog ⇒ present in init,
   key-login export, and metadata aliases when `jawcodeBundle` set.
4. `minimax/minimax-m2.5` catalog slug receives metadata (context window) after normalizer ships.

## Decisions resolved before implementation

1. **Canonical Azure adapter:** `azure-openai`; `azure` remains accepted as a legacy compatibility
   alias in the server adapter resolver.
2. **Kimi OAuth baseUrl:** `https://api.kimi.com/coding/v1`; `moonshot` remains a separate API-key
   provider row.
3. **Featured set:** preserve the exact 13 non-custom static presets from the pre-130 GUI picker.

---

## Related phases

| Phase | Link |
|-------|------|
| 110 | Stream reliability — orthogonal |
| 120 | WS parity — catalog `supports_websockets` still separate policy |
| jawcode | `models.json` remains upstream for bundled metadata content |
