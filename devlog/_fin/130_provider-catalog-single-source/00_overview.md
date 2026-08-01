# 130.00 — Overview: Provider Catalog Single-Sourcing

## What this phase is

opencodex advertises and configures LLM providers through **three hand-maintained catalogs**
that are supposed to stay aligned but are edited independently. When they drift, users see a
provider in the GUI that `ocx init` cannot offer, or a configured provider that never receives
bundled jawcode model metadata in the Codex catalog.

Docs 00–02 inventory every catalog entry across the three surfaces, document the two hotfixed
drift bugs from this work cycle as motivating symptoms, and design a single-source-of-truth
registry with an incremental migration path and a CI drift guard. Docs 10–30 record the Phase
130 implementation that followed.

## Symptom (motivating bugs — already hotfixed)

Two independent drift bugs were discovered and patched in the same work cycle. They illustrate
why manual triple-maintenance fails:

| ID | Symptom | Root cause | Hotfix (this cycle) |
|----|---------|------------|---------------------|
| **BUG A** | `opencode-go` appeared in the GUI quick-pick (`AddProviderModal.tsx:35`) and had bundled metadata (`PROVIDER_ALIASES` → `opencode-go`), but **`ocx init` could not offer it** and `enrichProviderFromCatalog("opencode-go", …)` was a no-op | GUI `PRESETS` + metadata alias existed; `KEY_LOGIN_PROVIDERS` entry was missing | Added `opencode-go` to `KEY_LOGIN_PROVIDERS` (`key-providers.ts:75-77`) |
| **BUG B** | `minimax` / `minimax-cn` were in `KEY_LOGIN_PROVIDERS` (`key-providers.ts:71-72`) but **had no metadata alias** → no bundled jawcode rows; jawcode also uses different provider id naming (`minimax` / `minimax-code` / `minimax-code-cn` vs opencodex `minimax` / `minimax-cn`) | Metadata generator never mapped opencodex ids to jawcode's `minimax` bundle | Added `minimax` / `minimax-cn` → `minimax` in `PROVIDER_ALIASES` (`generate-jawcode-metadata.ts:15-16`) and regenerated `jawcode-model-metadata.ts` |

BUG A violated the explicit **GUI↔CLI parity contract** in `init.ts`. BUG B broke the metadata
enrichment path in `codex-catalog.ts:90-99`.

## The parity contract (and how drift violates it)

`buildInitProviders()` documents that the CLI init menu is assembled from the **same registries
the GUI uses**, plus a small hardcoded set:

```33:36:src/init.ts
/**
 * The full CLI provider menu, built from the SAME registries the GUI uses (OAUTH_PROVIDERS +
 * KEY_LOGIN_PROVIDERS) plus the ChatGPT-forward, a few non-catalog key providers, and local servers —
 * so `ocx init` reaches provider parity with the GUI. Exported for verification.
 */
```

In practice the GUI also has a **second surface**: static `PRESETS` in
`AddProviderModal.tsx:29-43` (14 quick-pick rows including `custom`) that are **not** all
re-exported from `KEY_LOGIN_PROVIDERS` or `OAUTH_PROVIDERS`. The modal merges static presets
with `/api/key-providers` at runtime (`AddProviderModal.tsx:86-100`). Metadata aliases form a
**third** surface (`generate-jawcode-metadata.ts:4-17` → `codex-catalog.ts:93-99`). None of
the three is derived from a shared canonical list today.

## TL;DR

1. **Three independent catalogs** today: GUI static `PRESETS` + runtime key-catalog fetch;
   CLI/registry (`OAUTH_PROVIDERS`, hardcoded init rows, `KEY_LOGIN_PROVIDERS`,
   `buildInitProviders()`); bundled metadata (`PROVIDER_ALIASES` → generated
   `jawcode-model-metadata.ts`).
2. **BUG A / BUG B** (hotfixed) prove the contract in `init.ts:33-36` is not enforceable without
   automation — manual edits to one surface silently break the others.
3. **Full audit** (`01_catalog-source-audit.md`) finds **additional live mismatches** beyond those
   bugs: GUI vs OAuth/init field disagreements for `kimi`, `anthropic`, `azure-openai`; GUI
   offline degradation (static presets only); 28/31 key-login ids with no metadata alias;
   model-id **casing fragility** for minimax (`MiniMax-M2.5` in metadata vs lowercase routed ids).
4. **Design** (`02_single-source-design.md`): one canonical provider registry; derive GUI
   presets, init menu, key-login export, and metadata alias map; incremental migration in four
   steps; CI test that fails when derived surfaces diverge.

## The three surfaces (at a glance)

| Surface | Primary location | Consumed by | Count (authoring time) |
|---------|------------------|-------------|------------------------|
| **A — GUI** | Static `PRESETS` (`AddProviderModal.tsx:29-43`) + `/api/key-providers` → `KEY_LOGIN_PROVIDERS` | Add-provider modal search/quick-pick | 13 featured static (excl. `custom`) + 31 key-login deduped → **43** selectable (when proxy up) |
| **B — CLI / registry** | `OAUTH_PROVIDERS` (`oauth/index.ts:19-65`), `buildInitProviders()` (`init.ts:38-61`), `KEY_LOGIN_PROVIDERS` (`key-providers.ts:26-91`) | `ocx init`, `enrichProviderFromCatalog`, login CLI | 43 init rows (1 forward + 3 oauth + 5 hardcoded key + 31 key-login + 3 local) |
| **C — Metadata** | `PROVIDER_ALIASES` (`generate-jawcode-metadata.ts:4-17`) → `src/generated/jawcode-model-metadata.ts` | `resolveJawcodeProvider` / `getJawcodeModelMetadata` → `applyJawcodeCatalogMetadata` (`codex-catalog.ts:90-99`) | 10 alias keys → 7 jawcode bundles |

## Scope & baseline

- **In scope:** cross-surface audit, divergence matrix, canonical registry design, migration
  plan, drift-guard test spec, casing-risk documentation.
- **Out of scope (this cycle):** implementing the registry, deleting legacy catalogs, changing
  provider wire behavior, jawcode `models.json` edits, regenerating metadata beyond what the
  hotfix already did.
- **Baseline at authoring time:** BUG A/B hotfixes present on working tree; `KEY_LOGIN_PROVIDERS`
  has 31 entries including `opencode-go`; `PROVIDER_ALIASES` includes `minimax` / `minimax-cn`.

## Documents

| Doc | Contents |
|-----|----------|
| `00_overview.md` | This file — framing, hotfix symptoms, parity contract, scope |
| `01_catalog-source-audit.md` | Surface-by-surface map + **complete divergence matrix** |
| `02_single-source-design.md` | Canonical registry shape, per-consumer derivation, migration, CI guard, risks |
| `03_implementation-plan.md` | Confirmed implementation decisions and file-level plan |
| `10_registry-scaffold.md` | Registry and projection scaffold implementation record |
| `20_wiring-and-compat.md` | Consumer wiring, compatibility aliases, and GUI/runtime integration record |
| `30_verification.md` | Final verification evidence and residual risk notes |
