# 000 — go-port-hardening: Plan

## Objective

Close behavioral gaps between the TypeScript oracle in `src/` and the Go runtime in
`go/` that reach the user through the dashboard. The port is far enough along to be
dogfooded (`~/.opencodex/dogfood/ocx-go-dev serve` is the live proxy on :10100), which
is exactly why silent divergences now show up as broken product surfaces rather than
missing features.

Three were confirmed live against that running binary on 2026-07-29:

1. A pool account that lost its credential cannot be deleted (404), so the accounts the
   dashboard tells the user to remove and re-add are the ones it refuses to remove.
2. `/api/system/memory` reports `runtime.MemStats.Sys` as `rss`, which is address space
   the runtime reserved, not resident memory.
3. The dashboard prints Go runtime numbers under JavaScript runtime labels, and its
   "details" hint teaches a diagnostic that cannot be true on Go.

A fourth (ChatGPT login never set `ForceLogin`, so no account picker ever appeared) was
found in the same pass and is already fixed on this branch in `abb4dbc32`; it is recorded
here as the pattern these phases keep re-finding, not as remaining work.

Evidence base: live HTTP against :10100, `ps` for the same pid, and the oracle sources
named per phase. Branch: `dev2-go`, per `AGENTS.md` branch policy for `go/` work.

## Loop-spec

- Loop archetype: spec-satisfaction repair. The oracle defines correct behavior for
  every phase, so each one has a checkable verifier rather than a metric to maximize.
- Write scope: `go/internal/**`, `gui/src/**`, `gui/tests/**`, and this plan unit.
- Out-of-scope: `src/` runtime behavior (read as the oracle only), GUI visual redesign,
  release/CI workflows, `main`/`preview` branches, and any destructive action on the
  user's real credentials or account data.
- Bounds: local commits per work-phase; push limited to `dev2-go`, which the user
  approved for this session and nothing wider.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP1 | `010_wp1_delete_account.md` | `DeleteCodexAccount` accepts a config entry as existence proof | — |
| WP2 | `020_wp2_real_rss.md` | Platform RSS probe replaces `MemStats.Sys` on the memory endpoint | — |
| WP3 | `030_wp3_runtime_labels.md` | Memory card labels the runtime it is actually talking to | WP2 |

## Accept criteria

Mirrored into `.codexclaw/goalplans/opencodex-go-typescript-src-go-go-dev2-go-wp1-de/goalplan.json`
as `c1`-`c6`:

- **c1** A credential-less pool account deletes with 200 against a rebuilt binary and
  disappears from the account list.
- **c2** The `__main__` (400) and unknown-id (404) guards still hold, proven by tests.
- **c3** The served `rss` tracks `ps` for the same pid where `MemStats.Sys` diverged.
- **c4** The probe builds for every release target under `CGO_ENABLED=0`.
- **c5** The card names the Go heap and Go runtime counters on a Go payload.
- **c6** All six locales carry the new keys; typecheck and the GUI suite pass.
