# Codex history sync hardening — close-out (re-audit 2026-07-03)

Re-audit (per user, after the 380 under-count): the item's actionable work is complete. Closing;
Design B is parked as an optional alternative, not pending work.

## Landed (functional goal met)

- **Design A hardening** (Loop 1): recoverable history-restore retry + surfaced skips + `ocx restore
  back` — commits `73e12b8`, `c63b5b5`. Verified: `isRecoverableHistoryError`/`withHistoryRetry`
  (`codex-history-provider.ts:148,356`), restore-warning + forward-sync (`codex-inject.ts:292,385`).
- **Routing-fallback fix** (the real defect behind Design B): Codex silently fell back to the
  `openai` provider because no ROOT `model_provider` was injected. Fixed by `744cc9e` — `codex-inject.ts`
  `setRootModelProvider()` (:120-135) now writes `model_provider = "opencodex"` at the TOML root so
  `codex exec` routes through the proxy. History remap for Codex App visibility already sets old
  chats to `model_provider = 'openai'` (`codex-history-provider.ts:345`).

## Design B — parked (optional alternative, not required)

`02_openai-override-design.md` proposes a DIFFERENT architecture: emit `[model_providers.openai]`
and DROP the root `model_provider` line (relying on Codex's default `openai` id). This was a "loop-2
decision" alternative. The current opencodex-root approach already solves the routing + visibility
problem, so Design B is a simplification/unification option, not a fix for a live defect. Revive only
if the openai-id approach is later preferred (e.g. to drop the history remap). Not pending work.

## Status: CLOSED — Design A + root-provider routing fix shipped and working; Design B parked optional.

## 2026-07-06 addendum — Design B unparked and shipped (revised form)

Design B was implemented on branch `dev-B` in unit `devlog/_plan/260706_design-b-openai-base-url/`,
with one architecture correction over `02_openai-override-design.md`: `[model_providers.openai]`
is REJECTED by codex-rs (`RESERVED_MODEL_PROVIDER_IDS`, config load fails). The shipped form uses
the official root `openai_base_url` override instead. Loopback installs no longer re-tag
`model_provider`; history remap became a one-time backward migration; the zstd request-compression
path (`enable_request_compression` + `is_openai()`) is decoded by `src/request-decompress.ts`.
Legacy table injection remains for non-loopback binds. See the 2607 unit for evidence.
