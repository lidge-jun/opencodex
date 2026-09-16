# 060 — Merge ledger and closeout (append-only)

Rows are appended by each work-phase's D. Landing SHA proof: `git fetch origin dev &&
git merge-base --is-ancestor <sha> FETCH_HEAD` → exit 0.

| WP | Item | Disposition | Carry branch / PR | Head SHA | CI run id | Landing SHA | Ancestry proof (cmd + exit) | Original closed (comment URL) |
|----|------|-------------|-------------------|----------|-----------|-------------|-----------------------------|-------------------------------|
| wp0 | roadmap unit | docs | codex/260905-open-work-closeout-roadmap / #3538 | bf091040b | ci 9 pass/9 skip | d6b457462 | `git merge-base --is-ancestor d6b457462 FETCH_HEAD` → 0 | n/a |
| wp1 | #3323 | LAND_AS_IS (carry) | codex/260905-carry-3323 / #3539 | cc599fb79 | 25 pass/3 skip | 32e059724 | ancestor → 0 | pending wp6 |
| wp1 | #3515 | LAND_AS_IS (carry) | codex/260905-carry-3515 / #3541 | 696847cd4 | 28 pass/2 skip | 7f5b6e0a6 | ancestor → 0 | pending wp6 |
| wp1 | #3525 | LAND_AS_IS (carry) | codex/260905-carry-3525 / #3542 | 16c5df4a1 | 28 pass/2 skip | 7eddfb3eb | ancestor → 0 | pending wp6 (#3522 keep-open) |
| wp1 | #3490 | LAND_AS_IS + layout reg (carry) | codex/260905-carry-3490 / #3545 | 8b5370900 | 28 pass/2 skip | 375f1fa27 | ancestor → 0 | pending wp6 |
| wp1 | #3529 | LAND_AS_IS (carry) | codex/260905-carry-3529 / #3546 | 7c922afaf | 24 pass/2 skip | 583d6a91b | ancestor → 0 | pending wp6 |
| wp1 | #3484 | LAND_AS_IS (carry) | codex/260905-carry-3484 / #3540 | d30b3c4e4 | 28 pass/2 skip | 1362b1a38 | ancestor → 0 | pending wp6 |
| wp1→wp2 | #3480 | LAND_AS_IS (carry) | codex/260905-carry-3480 / #3544 | 368c5137a | 24 pass/2 skip (macos 2/2 green on rerun) | 445742966 | ancestor → 0 | pending wp6 |
| wp2 | #3502 (1/2) | LAND_WITH_FIX (B1) | codex/260905-oauth-failover-policy-boundaries / #3561 | c2ba04a85 | 24 pass/2 skip | 71cfc8de6 | ancestor → 0 | pending wp6 |
| wp2 | #3502 (2/2) | LAND_WITH_FIX (B2) | codex/260905-kiro-continuation-auth-context / #3562 | 49c48662f | 24 pass/2 skip | 24cc558d5 | ancestor → 0 | pending wp6 |
| wp2 | #3519 | LAND_WITH_FIX (B3) | codex/260905-claude-native-fallback / #3563 | dc074672e | 24 pass/2 skip (macos 2/2 green on rerun) | adcf8a753 | ancestor → 0 | pending wp6 |
| wp2 | #3524 | REIMPLEMENT (B4) | codex/260905-startup-reconcile-persistence / #3564 | 29182deb6 | 24 pass/2 skip | 526d4bf64 | ancestor → 0 | pending wp6 |
| wp2 | #3348 (PR A) | REIMPLEMENT (B6) | codex/260905-combo-failure-classification / #3565 | 6a31fcb77 | 24 pass/2 skip | a594a7f21 | ancestor → 0 | pending wp6 (persistence/policy halves deferred) |
| wp2 | #3489 | LAND_WITH_FIX (carry) | — gated on parallel #3551 | dbcfde8ca | — | — | — | residual → later work-phase |
| wp2 | #3469 / #3407 | HANDED_TO_PARALLEL | #3547 / parallel wp6 (unit 260905_bug_triage_stack) | — | — | — | — | tracked there |
| wp3 | #3444 | LAND_WITH_FIX (carry) | codex/260905-v2-passthrough-3444 / #3579 | 560bc2aa5 | 24 pass/2 skip | 760eddee1 | ancestor → 0 | pending wp6 |
| wp4 | #3447 | LAND_WITH_FIX (L1) | codex/260905-antigravity-ollama-quota / #3587 | 4a721e459 | final-tip run (see wp6) | dcdad53b8 | ancestor → 0 | pending wp6 |
| wp4 | #2783 | LAND_WITH_FIX (L2) | codex/260905-quota-reset-detection / #3592 | 80873166e | final-tip run (see wp6) | 2188fcac8 | ancestor → 0 | pending wp6 |
| wp4 | #2973 | LAND_WITH_FIX (L3) | codex/260905-quota-window-activation / #3588 | 7c7e77968 | final-tip run (see wp6) | 593978db0 | ancestor → 0 | pending wp6 |
| wp4 | #2956 | DEFER | — | cc6aa5f48 | — | — | — | comment at wp6 (474 behind, unreviewed, semantic conflicts) |

## Closure comments (issue/PR → landing SHA)

(none yet)

## Verifier policy

No repository-wide local suite was run in any phase; focused files, `bun run typecheck`,
`bun run test:changed`, and exact-head hosted CI only. Pushes use `--no-verify` because the
pre-push hook would run the forbidden suite.

## wp6 stop condition (authoritative)

Every LAND/REIMPLEMENT/IMPLEMENT row has a landing SHA with ancestry exit 0 and an
original-closure link (or an explicit keep-open rider: #3522, #3462); every DEFER/SUPERSEDED
has a closure or comment link; `bun run privacy:scan` exit 0 on the closeout commit; then the
unit moves to `devlog/_fin/`. The ledger header above is the single schema (010 §7 was aligned
to it in audit round 2).

