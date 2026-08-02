# 260802 Issue/PR Triage — 010 Triage Matrix

Date: 2026-08-02. Builds on `000_research.md` (audited, PASS). Every open
issue (37) and open PR (32) of `lidge-jun/opencodex` appears exactly once.
Classifications cite the evidence in the research doc; nothing was posted to
GitHub during this triage.

## Part 1 — Pull requests (32)

### 1a. Merge candidates — review and land (5 + 1 conditional)

| PR | What | Evidence |
|---|---|---|
| 866 | classify reset-eligible quota rejection (first slice of #657) | full CI green, bounded body handling, focused tests; no maintainer review yet |
| 862 | docs: clarify pool routing and account continuity | docs-only, locales synced, CI green, bot findings resolved |
| 860 | gate service tiers by provider capability | fixes DeepSeek breakage from OpenAI-only `service_tier`; wire tests + docs; run full CI before landing |
| 854 | honor authoritative context windows in generated Claude profiles | minimal fix + regression test; full CI is the final gate |
| 853 | reasoning-effort ladders on raw /v1/models | CI green, all bot findings addressed, Wibias verified |
| 653 | Baseten preset — CONDITIONAL | security APPROVED on current head, CI green; blocked only by stale lidge-jun CHANGES_REQUESTED → owner re-review/dismiss |

### 1b. Build-ourselves-worthy — immature PRs, but the capability is valuable enough to own (2)

| PR | What | Why it matters / what is missing |
|---|---|---|
| 865 | opt-in same-target 429 wait-and-retry before key failover (#487) | Core proxy resilience for single-key and pooled providers; extensive tests; author resolved 20 bot findings (worst Critical). Missing: full CI + maintainer architecture review of a 1,965-line, 37-file cross-surface change. If the author stalls, maintainers should adopt the design and re-land it in slices. |
| 863 | encrypted native main profiles (implements #656) | Transactional switching/recovery among native Codex main accounts is a repeatedly requested capability. Missing: explicit security + design review (new native keyring dependency, 401-line vault module, credential storage). Maintainer should drive the security review even if the draft needs a maintainer takeover. |

### 1c. Needs author work (21)

| PR | One-line reason |
|---|---|
| 868 | ownership-loss edge test open; full platform CI not run |
| 861 | mature (follows #848 spec) but macOS CI failure undiagnosed |
| 850 | localized docs (ja/ko/ru) inconsistent with the CORS fix |
| 839 | Claude 1M context is real (web-verified 2026-08-02); reconcile generated 200k metadata contract first — likely quick win after that |
| 837 | conflicts with dev; unresolved wire-default + inherited-property findings (supersedes #616) |
| 847 | #820-series draft; conflicts with dev; needs rebase + independent review |
| 845 | #820-series draft; conflicts; overlaps Cursor surfaces with #844 |
| 844 | #820-series draft; conflicts; see #845 |
| 843 | #820-series draft; conflicts; needs rebase + independent review |
| 841 | #820-series draft; conflicts; needs rebase + independent review |
| 840 | #820-series draft; conflicts; needs rebase + independent review |
| 812 | Apertis routing/resale authorization needs maintainer verification pre-security |
| 811 | 15k lines unreviewable as one unit; Unix-only APIs in Windows Rust build; GUI tests fail; conflicts |
| 746 | P2 catalog/selector findings; rebase; credential-replay security approval; CI rerun |
| 744 | UNSTABLE (Ubuntu/Windows fail); standing CHANGES_REQUESTED; head newer than approval (audit-corrected) |
| 715 | LAND-AFTER #671; GUI conflicts; exact-selector bypass regression; P2s; security review |
| 693 | malformed success response preserves stale last-good credit; needs terminal-vs-transient split + regression |
| 671 | code accepted; credential-selection security sign-off + P2s pending; land before #715 |
| 581 | zh-TW conflicts would delete revived workspaces; parity check, builds, rendered smoke, native-speaker review |
| 569 | rebase, ready transition, fresh CI, independent review of unauthenticated endpoint |
| 557 | live whitespace-path redaction leak; non-mechanical conflicts; mandatory security review |

### 1d. Close or defer (3)

| PR | One-line reason |
|---|---|
| 644 | invalid repro; no regression coverage; unrelated scheduler hunk regresses dev |
| 616 | implementation accepted but moved into #837; retain only until #837 lands |
| 707 | first tranche landed via #697; 8k-line conflicted multi-threat-model draft with P1s — replace with focused PRs |

## Part 2 — Issues (37)

### 2a. Not yet reviewed — solid reports awaiting first maintainer response (5)

| Issue | Severity | One-line assessment |
|---|---|---|
| 858 | HIGH | archived-session cleanup ignores `is_pinned` → credible permanent task-data-loss; fix-now |
| 864 | HIGH | WebSocket turn never completes (2.7.43/2.8.0); strong bisect + rollback proof; fix-now |
| 859 | MED | Claude Desktop alias not reverse-mapped → 400 from DeepSeek; fix-now |
| 855 | MED | deleting provider leaves ghost models in Codex catalog after sync; fix-now |
| 857 | MED | stale app-server roster vs spawn_agent allowlist drift; investigate detection |

### 2b. Actionable — reviewed, accepted, implement-soon (9)

| Issue | Value | Note |
|---|---|---|
| 821 | high | deterministic pool failover; PR #715 after #671 |
| 809 | high | read-only data-plane catalog route; accepted scope |
| 806 | high | bounded copy/help correction across UI/CLI/docs/locales |
| 753 | high | GUI loading-state + 38-request amplification; plan specified |
| 658 | high | AgentRouter terminal-SSE compat; registry-gated, fail-closed |
| 425 | high | account namespaces in picker; PR #671 implements |
| 414 | high | Exa-first web-search sidecar backend; scope concrete |
| 386 | med | macOS menu bar companion; superseded by `feat/macos-app`; finish review + release integration |
| 848 | low | doctor Bun-provenance; PR #861 open per maintainer spec |

### 2c. Design-blocked — valuable, needs design/lifecycle contract first (9)

| Issue | Value | Blocking question |
|---|---|---|
| 822 | high | auto-redeem credits: freshness, idempotency, crash recovery, audit |
| 823 | med | quota-reset activation: needs documented upstream operation; no unsolicited synthetic requests |
| 657 | high | quota-recovery umbrella; #866 is slice 1; redemption lifecycle separate |
| 656 | high | native main-account switching: credential lifecycle + security review (PR #863) |
| 586 | med | codexAccountMode UI: canonical control location undecided |
| 545 | high | Claude Desktop 64-token classifier: no safe proxy fix without contract changes |
| 415 | high | search sidecar backends: capability/citation/auth/quota matrix first |
| 178 | med | Factory: agent backend, not model inference — what would integration mean? |
| 177 | med | Warp: Oz API launches environment agents, not selectable inference |

### 2d. Tracking / umbrella (5)

| Issue | Note |
|---|---|
| 820 | memory-bounded concurrency umbrella; PRs #840-#847 cover confirmed retention points |
| 755 | maintainer release queue / security review tracker |
| 572 | verified-provider-batch umbrella; discovery infra landed via #652 |
| 540 | WordPress Studio: blocked on Automattic authorization |
| 95 | multi-user hosting roadmap tracker |

### 2e. Needs info / evidence (6)

| Issue | What's missing |
|---|---|
| 796 | live Volcengine Ark confirmation of host-gated candidate fix |
| 695 | auto-switch triggers, affinity rules, unknown-quota handling |
| 561 | Modelsell API docs, legal entity/resale authorization, named maintainer |
| 553 | clean-network retest (evidence implicates VPN fake-IP interception) |
| 418 | one same-run three-boundary spawn_agent trace |
| 201 | TRAE International: CLI still "coming soon" (verified 2026-08-02); no sanctioned API |

### 2f. Upstream-blocked (3)

| Issue | Upstream state |
|---|---|
| 417 | Korean realtime U+FFFD; openai/codex#35161 OPEN; ocx exonerated by relay tests |
| 241 | Desktop native-only allowlist filters correct catalog; no linked upstream ticket |
| 92 | V2 cross-provider NEW_TASK encryption; no linked upstream ticket (thread's #32453 is unrelated) |

## Summary counts

- PRs: 5 merge-candidates + 1 conditional, 2 build-ourselves-worthy,
  21 needs-author-work, 3 close-or-defer. (32)
- Issues: 5 unreviewed-solid, 9 actionable, 9 design-blocked, 5 tracking,
  6 needs-info, 3 upstream-blocked. (37)

Top of the queue suggested by this triage: answer the 5 unreviewed solid
bug reports (#858 and #864 first — both high-severity), land the
merge-candidate PRs, and schedule security review for the two
build-ourselves-worthy PRs (#865, #863).
