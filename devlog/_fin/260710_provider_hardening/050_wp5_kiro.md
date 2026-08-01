# 050 — WP5: kiro

Pre-analysis: Carson (sol explorer, 2026-07-10). Re-verify at WP5's P.

## P scope decision (260710, main session)

IN this cycle (loud-failure + narrow-retry + dead-code class):
- K1 kiro.ts:503 — blank/missing token becomes `Bearer ` empty header => throw
  before I/O ("kiro token missing — run ocx login kiro").
- K2 kiro-retry.ts catch breadth (:63-68) — retries EVERY thrown exception incl.
  deterministic failures => classify: retry only transient network errors
  (isConnectionResetError + timeout-class); deterministic errors rethrow
  immediately. HTTP status gate (429/5xx) unchanged — already narrow.
  AMENDED A-round1: tests MUST cover both directions — positive
  retained-transient retries (reset/EPIPE + the per-attempt timeout-abort class
  existing tests rely on) AND deterministic immediate rethrow (TypeError/URL).
- K3 (KILLED A-round1): complete tool JSON at EOF without tool_stop is REAL
  upstream behavior with a dedicated compat test recovering it; incomplete JSON
  is already classified as truncation error. NOOP-with-rationale.
- K4 kiro.ts:447 — tool_stop with no open tool silently ignored => adapter error.
- K5 kiro-models.ts:51 — unreachable kiro-auto normalize branch removed.
- K6 (FINAL, A-round2) kiro-credentials.ts:60 — present-but-unparseable expiry:
  loud warning always; expired treatment ONLY when a refresh token exists
  (refresh path is real); access-only credentials (no refresh token) get the
  warning + default TTL so they are never bricked into an empty-refresh throw.
  Missing expiry keeps default TTL silently (legitimate shape). Tests:
  malformed-expiry-with-refresh => expired+refresh, malformed-expiry-access-only
  => warned+default TTL (not bricked), missing-expiry => default TTL no warning.

OUT (recorded honestly):
- Orphan tool-result textification + synthetic role-order carriers: Kiro wire
  REQUIRES alternating roles; the carriers are protocol shims (documented), and
  orphan-throw would break real Codex compaction flows — NOOP-with-rationale
  unless reviewer proves a narrow orphan class that is safely rejectable.
- Graded reasoning-effort honesty (prompt-tag efforts): catalog/UI surface
  change across kiro-models + catalog + GUI; visible behavior change needing
  its own cycle — WP10 candidate, named not silent.
- Registry baseUrl ignored by adapter (region-built URL): documented design
  (region resolution); a loud reject of custom baseUrl would break nothing but
  adds a guard with no researched user need — defer, named.
- kiro-images silent drops + schema flattening: protocol-compat, test-locked.
- KIRO_MODELS staleness: FREEZE (no Kiro-side Tier-2 catalog proof; 2026-06-19
  in-repo evidence stands).

## Staleness

kiro-models.ts catalog dated 2026-06-19, no preserved provenance snapshot;
claude-sonnet-5 1M ctx explicitly speculative; sonnet-4.6 ctx conflicts with
generated Anthropic metadata (1M vs 200K); deepseek-3.2/glm-5/M2.x older than
other registries (signal only — Kiro's own catalog governs; FREEZE without
Kiro-side proof). kiro-auto normalize branch unreachable (kiro-models.ts:51).

## Hardening targets

1. kiro.ts:503 — missing auth becomes `Bearer ` (empty) => throw before I/O.
2. kiro-retry.ts (main-session cross-check 260710): HTTP status gate is already
   narrow (429/500/502/503/504 only — Carson's "all 429 incl. quota" claim needs
   care: kiro has no separate quota signal; keep status gate as-is). The REAL
   over-breadth is the catch branch (:63-68) retrying EVERY thrown exception
   (incl. deterministic TypeError/TLS/URL failures) => narrow to transient
   network classes via isConnectionResetError-style classification.
3. kiro.ts:469/447/436 — EOF tool JSON without tool_stop emitted as success;
   stop-without-open ignored; id/name mismatch merge risk => reject.
4. kiro-tool-fallback.ts / kiro.ts:280,293 — orphaned tool results textified even
   when tools advertised => throw history-contract error for orphans; keep only
   documented role-order carriers ((acknowledged)/(continue) protocol shims).
5. kiro-images.ts:12 — invalid/remote images silently dropped => reject.
6. Reasoning efforts: all models advertise 5 graded efforts but they are prompt
   tags (kiro.ts:174) => capability honesty fix; verify catalog/UI impact.
7. kiro-credentials.ts:60 — malformed expiry silently = now+1h => loud.
8. Registry baseUrl ignored (adapter builds from region, kiro.ts:534) => reject
   custom baseUrl explicitly or honor it; no silent ignore.
9. Remove unreachable kiro-auto branch (kiro-models.ts:51).

## Tests
99 kiro tests currently pass. ADD negatives: empty token, malformed ARN, quota
429 no-retry, deterministic-error no-retry, stop-without-start, JSON-without-stop,
mismatched tool ids, invalid images, custom-baseUrl rejection.
