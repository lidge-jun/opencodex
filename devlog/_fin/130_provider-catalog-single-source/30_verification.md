# 130.30 — Verification

## New drift guard

`tests/provider-registry-parity.test.ts` covers the Phase 130 invariants:

| Test area | Assertion |
|-----------|-----------|
| Registry uniqueness | Provider ids are unique. |
| Key-login projection | `KEY_LOGIN_PROVIDERS` equals `deriveKeyLoginMap()` and matches a frozen 36-id endpoint set. |
| CLI init projection | `buildInitProviders()` equals `deriveInitProviders()`. |
| OAuth canonical fields | Kimi URL, Anthropic default, and xAI default derive from registry values. |
| GUI featured set | The current 13 non-custom featured providers are preserved and `custom` remains last. |
| Metadata aliases | Registry-derived aliases match generated alias behavior for `gemini` and `minimax-cn`. |
| Legacy Azure | `adapter: "azure"` still resolves to the Azure adapter. |
| MiniMax casing | `minimax/minimax-m2.5` receives context metadata through the catalog path. |

## Verification commands

### Targeted registry guard

```bash
bun test tests/provider-registry-parity.test.ts
```

Result: pass, 8 tests.

### Full test suite

```bash
bun test tests
```

Result: pass, 60 tests across 13 files.

### TypeScript

```bash
bun x tsc --noEmit
```

Result: pass.

### GUI build

```bash
bun run build:gui
```

Result: pass. Vite built `gui/dist` successfully.

## Line-limit check

All new Phase 130 implementation files are under the 500-line project limit:

| File | Lines |
|------|-------|
| `src/providers/registry.ts` | 140 |
| `src/providers/derive.ts` | 163 |
| `tests/provider-registry-parity.test.ts` | 102 |
| `devlog/130_provider-catalog-single-source/10_registry-scaffold.md` | 69 |
| `devlog/130_provider-catalog-single-source/20_wiring-and-compat.md` | 83 |
| `devlog/130_provider-catalog-single-source/30_verification.md` | 60 |

## Residual risks

| Risk | Status |
|------|--------|
| GUI endpoint unavailable | The modal keeps a minimal `custom` fallback. This is more degraded than the pre-130 static-preset fallback, but it avoids preserving a second authored provider catalog in the standalone GUI package. |
| Unknown provider metadata | Still intentionally sparse; registry `jawcodeBundle` opt-in controls bundled metadata coverage. |
| Existing third-party docs mentioning `azure` | Runtime remains compatible through alias; README now documents `azure-openai`. |
| Generated metadata file long lines | Existing generated style preserved; file remains under the line-count limit. |
| `/api/key-providers` id set | Shape is unchanged, but the set intentionally expands from 31 dedicated key-login rows to 36 `authKind: "key"` registry rows so featured API-key providers are no longer maintained outside the key projection. The parity test now freezes this set. |

## Done assessment

Phase 130 now has one authored provider registry, derived consumers, drift/parity tests, preserved
legacy compatibility, and passing full verification gates.
