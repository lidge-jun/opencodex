# Phase 2 — codex-inject Design B rewrite

Replace the re-tag injection (`model_provider = "opencodex"` + `[model_providers.opencodex]`)
with the official built-in override: root `openai_base_url = "http://<host>:<port>/v1"`.
Threads stay tagged `openai`; no history remap needed forward.

## Mode split (decision)

- **Loopback (default)**: Design B. Emit marker + `openai_base_url` root key only.
- **Non-loopback** (`shouldInjectApiAuthHeader` true — remote bind needs the
  `x-opencodex-api-key` env header, which a built-in provider cannot carry):
  KEEP the legacy opencodex-table injection unchanged. Legacy path keeps its
  forward history sync; Design B path does not.

## Files

**MODIFY `src/codex-inject.ts`**

1. NEW `buildOpenaiBaseUrlLine(port, hostname?)`:
```ts
export function buildOpenaiBaseUrlLine(port: number, hostname?: string): string {
  return `openai_base_url = "http://${providerBaseHost(hostname)}:${port}/v1"`;
}
```
2. NEW root-key setter `setRootOpenaiBaseUrl(content, port, hostname)`:
   insert `OCX_SECTION_MARKER` comment + the line BEFORE the first table header
   (same insertion discipline as `setRootModelProvider`). If a root
   `openai_base_url` already exists and is NOT marker-owned (user's own), leave it
   and do not inject a duplicate — journal still snapshots the original for restore;
   report "kept user openai_base_url" in the message. If a marker-owned line exists,
   replace it (idempotent re-inject).
3. NEW `stripInjectedOpenaiBaseUrl(content)`: remove the marker line + the
   immediately following root `openai_base_url` line (marker-adjacent only —
   a user's own override elsewhere survives). Tolerate marker-orphan lines.
4. `injectCodexConfig(port, config, options)`:
   - keep: journal write, legacy cleanup (`removeOcxSection`, `removeProfileSection`,
     `stripExistingModelProvider` — now removing the legacy root model_provider is the
     UPGRADE path), context-window strip, service-tier normalize, fast_mode, catalog.
   - branch: `if (shouldInjectApiAuthHeader(config))` → legacy body unchanged
     (root model_provider + provider table + forward history sync).
   - else Design B: `setRootOpenaiBaseUrl`; do NOT call `setRootModelProvider`;
     do NOT append the provider table. History: phase 3 migration call.
   - message text updated ("Codex built-in openai provider now points at the proxy;
     threads keep their native provider tag.").
5. `buildProfileFile` (fallback `opencodex.config.toml`): Design-B variant becomes
   root `openai_base_url` + optional catalog + `[features] fast_mode`; drops
   model_provider + table. Legacy variant unchanged for non-loopback.
6. `stripOpencodexConfig`: additionally run `stripInjectedOpenaiBaseUrl`; keep all
   legacy stripping (downgrade/upgrade safe both ways). `hasOpencodexRouting` also
   returns true when a marker-owned openai_base_url line exists (so
   `removeCodexConfig` reports correctly).
7. `restoreNativeCodex`: unchanged flow (journal → fallback strip → catalog →
   `syncCodexHistoryProvider("openai")` — post-migration that call is a cheap no-op
   that also covers interrupted legacy states).

## Audit fixes folded in (2026-07-06 reviewer verdict)

- **(blocker 1) `stripRootRoutedModel` gate:** in `stripOpencodexConfig`, fire the
  routed-model strip when EITHER legacy root `model_provider == "opencodex"` OR a
  marker-owned `openai_base_url` line is present (`hadInjectedBaseUrl`). Otherwise a
  TUI-persisted root `model = "provider/slug"` survives fallback restore and breaks
  native codex against real OpenAI.
- **(blocker 2) `tests/shutdown-launcher.test.ts:96`** asserts the loopback injected
  config contains `model_providers.opencodex` — update to assert the Design B shape
  (marker + `openai_base_url`); the `:112 not.toContain("opencodex")` restore assert
  requires the fallback strip to remove the marker line too (covered by
  `stripInjectedOpenaiBaseUrl`).
- **(blocker 3) `buildProfileFile` discriminator:** the Design-B-vs-legacy variant is
  keyed on `includeApiAuthHeader` (the same boolean `injectCodexConfig` derives from
  `shouldInjectApiAuthHeader(config)`), NOT re-derived from hostname. So
  `buildProfileFile(port, cat, ws, /*includeApiAuthHeader*/ true, host)` keeps the
  legacy table shape and `tests/codex-inject.test.ts:135-139` stays green;
  `:119-124` (loopback default) must be updated to the Design B profile shape.
- **(adv 4) profile file semantics:** `opencodex.config.toml` is a standalone
  reference/fallback file (not consumed by codex `--profile`); its Design-B variant
  documents the root `openai_base_url` line. The stale "--profile opencodex" header
  comment gets rewritten to describe manual use.
- **(adv 6) journal hash on upgrade:** first Design-B inject over a legacy-session
  journal produces one expected hash mismatch → fallback strip path. Accepted; the
  fallback strip handles both forms. No hash refresh (journal keeps the ORIGINAL
  pre-ocx snapshot as source of truth).
- **(adv 7)** `decodeRequestBody` caps decompressed size (64 MiB) — throw on exceed.

**MODIFY `tests/codex-inject.test.ts`** — new cases:
- Design B inject emits marker + root openai_base_url before first table; no
  `[model_providers.opencodex]`, no root model_provider.
- Re-inject idempotent (port change rewrites the marker-owned line once).
- Upgrade path: config carrying legacy table + root model_provider = "opencodex"
  → after inject only Design B form remains.
- User's own root openai_base_url (no marker) → preserved, no duplicate injected.
- strip removes marker-owned line only; user line survives.
- Non-loopback config still emits legacy table + env_http_headers (regression).
- Profile file Design B shape.

## Accept

- `bun test tests/codex-inject.test.ts tests/codex-journal.test.ts` green.
- `bun test` full green.
- rg proof: no remaining call path injects the opencodex table for loopback configs.
