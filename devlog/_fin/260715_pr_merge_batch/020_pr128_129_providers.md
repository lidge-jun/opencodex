# 020 — Land PR #128 (OpenCode Free) + #129 (MiMo Free) keyless providers

Work-phase: `wp2-pr128-129-providers`. One full PABCD cycle covering both PRs (same
author, overlapping surface). Diff sources: `diffs/pr128.patch`, `diffs/pr129.patch`.

## What the PRs do

### #128 OpenCode Free (~550 ins)

- New keyless public-tier provider wired through `src/providers/registry.ts`,
  `src/providers/derive.ts`, `src/codex/catalog.ts`, `src/server/relay.ts`,
  `src/server/request-log.ts`, `src/server/management-api.ts`, `src/server/auth-cors.ts`,
  `src/adapters/openai-chat.ts`.
- GUI: `AddProviderModal.tsx`, `Providers.tsx`, `provider-icons.ts`.
- Tests: `opencode-free-provider.test.ts` (new), `provider-live-models.test.ts`,
  `provider-registry-parity.test.ts`, `request-log.test.ts`, `server-auth.test.ts`,
  `claude-agents-inject.test.ts`.

### #129 MiMo Free (~470 ins)

- New adapter `src/adapters/mimo-free.ts`; registry/derive/adapter-resolve/auth-cors
  wiring; GUI modal/page/icons; tests `mimo-free-provider.test.ts` (new) +
  parity/server-auth updates.

## Security gate (RESOLVED at roadmap cycle; owner decision recorded)

- #128 endpoints VERIFIED legitimate from primary sources (opencode.ai/docs/zen +
  opencode server source). PASS.
- #129 endpoints: Xiaomi MiMoCode anonymous free tier officially confirmed; exact
  bootstrap/chat contract is reverse-engineered. PASS per repo norm (first-party client
  emulation is core architecture — client-fingerprint.ts, kiro, antigravity), with
  mandatory privacy fixes below. Residual contract-change risk documented in provider
  note and surfaced to user in final report.
- OWNER DECISION (audit item 4): auditor flagged that MiMo differs qualitatively from
  credentialed emulation (anonymous anti-abuse gate crossed via identity marker; ToS/
  availability risk). Recorded decision: the repo owner's kickoff instruction for this
  loop ("굳이 그사람 pr이 리젝을 하는게 아니라 우리가 거기에 더 쌓아도 되고") plus standing
  capability-over-caution preference is treated as acceptance of ToS/availability risk;
  a non-blocking notice was posted to the user during the run with an explicit
  opportunity to halt. If the user objects before WP2's B phase, #129 flips to skip.

## Overlap / landing order (locked from Goodall conflict map)

Both PRs touch: registry.ts, derive.ts, openai-chat.ts, auth-cors.ts,
AddProviderModal.tsx, Providers.tsx, provider-icons.ts, parity + server-auth tests.
Landing order: **#128 first** (based on current main a50e147; #129 based on older
16bef043). Then #129, dropping duplicate hunks (keyOptional propagation, GUI shared
edits, symlink-skip test hunk — the latter lands via #130 in cycle 010 anyway).
Registry order: OpenCode before Xiaomi entry; MiMo after Kilo. Parity-test expected
arrays must contain both IDs in registry order.

## Landing plan (B phase)

1. `git merge --no-ff pr-128` (ref already fetched) -> resolve, then stacked fixes:
   - fix unused `hints` in `gui/src/provider-icons.ts:52` (CI-red cause); drop the
     premature `mimo-free` icon alias from #128's hunk (#129 re-adds its own).
   - revert `src/adapters/openai-chat.ts:445` header-precedence reversal; apply
     registry staticHeaders as a separate low-precedence layer (apiKey auth wins,
     preserving existing behavior).
   - bound the relay/request-log error-body capture: cap applies ONLY to the
     inspected/logged prefix (~8 KiB read for the 500-char store); the complete
     upstream error response must still be preserved/streamed to the client unchanged
     (no behavioral truncation of provider errors).
   - add free-tier data-use warning to the opencode-free registry note (Zen docs link).
   - test + typecheck green, commit.
2. `git merge --no-ff pr-129` -> resolve duplicates per conflict map, then stacked fixes:
   - replace machine-derived bootstrap `client` hash (hostname/OS/arch/CPU/username)
     with a persisted random UUID under the repo's config dir helper
     (`getConfigDir()` / OPENCODEX_HOME-aware; no hardcoded ~/.opencodex).
   - retry predicate: drain/cancel first response body, then retry ONCE on 401 only;
     403 is NOT retried unless a documented MiMo token-expiry signature in the body
     identifies it as retryable (align tests with this exact predicate).
   - bootstrap: propagate abort signal, add timeout, single-flight in-flight promise.
   - activation-level tests REQUIRED for each fix (audit item 2): UUID persistence
     under OPENCODEX_HOME, concurrent bootstrap single-flight, timeout/abort
     propagation, expired-token retry path, first-body disposal before retry, and NO
     retry for unrelated 403s.
   - drop its copy of the openai-chat precedence change + symlink-skip hunk.
   - add free-tier data-use / contract-risk note to registry entry.
   - test + typecheck green, commit.
3. Any residual review nits as a final commit.

## Verification (C phase)

- `bun test --isolate ./tests/` + `bun run typecheck` green after EACH merge.
- `cd gui && bun run lint` (or CI-equivalent) green — #128's red-CI cause was GUI lint.
- Registry parity test passes with both providers present.
- Spot-check: `ocx sync`-generated catalog unaffected for existing providers (no
  regression on existing provider entries; check derive snapshot tests).
- Existing `opencode-zen` provider behavior change from #128's host-based Zen schema
  sanitizer: verify it is intentional and covered by a test, or scope it to
  opencode-free.
