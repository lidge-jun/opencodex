# 260802 Issue/PR Triage — 000 Research Inventory

Date: 2026-08-02. Snapshot taken via GitHub GraphQL API (`gh api graphql`)
against `lidge-jun/opencodex`, open states only. 37 open issues, 32 open PRs.

Method: full inventory pull (number, title, author, labels, commenters,
reviewers), then deep per-item analysis dispatched to parallel analysis
agents (`gh pr view` / `gh issue view` with bodies, comments, CI rollups,
mergeable state), with external claims spot-verified by web search.

"Maintainer" below means lidge-jun (owner), Ingwannu (owner), or Wibias
(collaborator). Bot comments (github-actions issue-quality/translator bots,
coderabbitai, chatgpt-codex-connector) are not maintainer review.

## Raw inventory — issues (37)

| # | Title (short) | Reporter | Labels | Maintainer in thread? |
|---|---|---|---|---|
| 864 | Codex Desktop: turn never completes over WebSocket (2.7.43/2.8.0) | kowkowhuang | bug | no |
| 859 | Claude Desktop gateway routing: alias not reverse-mapped to DeepSeek (400) | vehiclerentropy | bug | no |
| 858 | archived-session cleanup does not exclude pinned threads (2.8.0) | GENEXIS-AI | bug | no |
| 857 | stale app-server vs injected roster / spawn_agent allowlist (2.8.0) | GENEXIS-AI | bug | no |
| 855 | deleting provider leaves routed models in Codex catalog after sync | Ttungx | bug | no |
| 848 | doctor repeats OPENCODEX_BUN_PATH guidance when override active | luvs01 | bug | Ingwannu (confirmed, PR requested) |
| 823 | auto-activate accounts right after quota reset | whitesarum | enhancement, account-pool | Ingwannu (design-blocked) |
| 822 | auto-redeem reset credits before expiry | whitesarum | enhancement, account-pool | Ingwannu (design-first) |
| 821 | user-defined priority order for pool failover | whitesarum | enhancement, account-pool, proxy | Ingwannu (accepted; PR #715) |
| 820 | architecture: 32 concurrent tool-recall sessions memory-bounded | lidge-jun | provider, streaming, tools | maintainer-authored |
| 809 | client credential read of GET /api/catalog | nbsp1221 | enhancement, account-pool, catalog, proxy, streaming | Ingwannu (accepted scope) |
| 806 | Auth UI/docs conflate usage-switching with rotation | luvs01 | documentation, account-pool | Ingwannu (accepted scope) |
| 796 | Volcengine Ark (Kimi-K3) 400 on assistant tool_calls | hooliy-01 | bug, provider, tools | lidge-jun |
| 755 | tracking: release queue, security review, blockers | lidge-jun | roadmap, account-pool, platform | maintainer-authored |
| 753 | GUI tabs: no loading state; 38 requests per switch | lidge-jun | bug, account-pool, gui, install | maintainer-authored |
| 695 | auto-switch antigravity accounts | luwei1990 | enhancement, account-pool | Ingwannu |
| 658 | AgentRouter Anthropic streams end without terminal SSE | brunoflma | provider-compatibility, provider, streaming, tools | Ingwannu |
| 657 | opt-in rejection-only quota recovery + reset-credit redemption | luvs01 | enhancement, account-pool, tools | Ingwannu, luvs01 |
| 656 | switch stored Codex account into native main login | luvs01 | enhancement, account-pool | Ingwannu |
| 586 | missing UI for codexAccountMode (Pool/Direct) on Providers page | jhste102lab | bug, account-pool | lidge-jun |
| 572 | promote verified batch of OpenAI-compatible providers | olddonkey | enhancement, provider, catalog, tools | Ingwannu, lidge-jun |
| 561 | add Modelsell as built-in provider | modelsell | enhancement, provider, tools | Ingwannu, lidge-jun |
| 553 | GitHub Copilot request fails 502 TLS hostname mismatch | burhiepotdult1982 | bug, provider | Ingwannu, lidge-jun |
| 545 | Claude Desktop 3P Auto classifier retries after 64-token outputs | PBJ-2 | bug, provider-compatibility, provider, account-pool, platform, tools | Ingwannu |
| 540 | add WordPress Studio Code as OAuth provider | SJY051 | provider-compatibility, roadmap, provider, account-pool, catalog, tools | Ingwannu |
| 425 | expose Codex accounts as model namespaces in picker | chrisae9 | enhancement, account-pool | Ingwannu |
| 418 | V2 custom-parent to custom-child delegation fails (2.7.39) | brunoflma | bug | Ingwannu, Wibias |
| 417 | tracking (upstream): Korean realtime transcript U+FFFD | lidge-jun | bug, upstream-tracking, cli | maintainer-authored |
| 415 | investigate search-API providers as web-search sidecar backends | lidge-jun | enhancement, account-pool, tools | maintainer-authored |
| 414 | add Exa and other search providers as sidecar backends | lidge-jun | enhancement, account-pool, tools | maintainer-authored |
| 386 | packaged macOS menu bar companion with release assets | jaycho46 | enhancement, platform, install | Ingwannu |
| 241 | routed models loaded by app-server but missing from Desktop picker | Lingchen97 | bug, upstream-tracking, catalog | lidge-jun, Wibias |
| 201 | add TRAE International provider | czwaxm | enhancement, roadmap, provider, account-pool, catalog, tools | lidge-jun, Wibias |
| 178 | add Factory as a provider | ardjo-s | enhancement, roadmap | Ingwannu, lidge-jun |
| 177 | add Warp as a provider | ardjo-s | enhancement, roadmap | Ingwannu, lidge-jun |
| 95 | multi-user hosting with ChatGPT passthrough + LiteLLM | rafalkwol | enhancement, roadmap | lidge-jun, Wibias (roadmap tracker) |
| 92 | V2 cross-provider sub-agent loses NEW_TASK body | webmastertorch | bug, upstream-tracking | lidge-jun, Wibias (upstream-blocked) |

## Raw inventory — PRs (32)

| # | Title (short) | Author | Draft | +/- | Maintainer review state |
|---|---|---|---|---|---|
| 868 | fix(windows): settle scheduler registration verification | ventianima-lab | no | +188/-1 | none (coderabbit 1 actionable) |
| 866 | feat(codex): classify reset-eligible quota rejection | luvs01 | no | +225/-3 | none |
| 865 | feat(proxy): opt-in same-target 429 wait-and-retry (#487) | harryzhou2000 | no | +1965/-70 | none (coderabbit criticals) |
| 863 | feat(codex): encrypted native main profiles | luvs01 | yes | +2479/-2 | none |
| 862 | docs(codex): clarify pool routing and account continuity | luvs01 | no | +471/-226 | none |
| 861 | fix(doctor): report Bun runtime provenance | luvs01 | no | +274/-41 | none (fixes #848 per maintainer spec) |
| 860 | fix(responses): gate service tiers by provider capability | F1Justin | no | +169/-18 | none |
| 854 | fix(claude): honor authoritative context windows in profiles | park285 | no | +17/-10 | none |
| 853 | feat(server): reasoning-effort ladders on raw /v1/models | n3wr1ch | no | +208/-4 | Wibias verified |
| 850 | fix(server): match browser extension CORS origins exactly | eachann1024 | no | +93/-8 | none |
| 847 | fix: bound streamed tool argument memory | Ingwannu | yes | +512/-87 | self (draft) |
| 845 | fix: bound Cursor blob-store memory | Ingwannu | yes | +418/-90 | self (draft) |
| 844 | fix: bound Cursor Connect frame buffering | Ingwannu | yes | +144/-10 | self (draft) |
| 843 | fix: bound Antigravity replay retention | Ingwannu | yes | +282/-24 | self (draft) |
| 841 | fix: enforce Responses state byte cap | Ingwannu | yes | +121/-12 | self (draft) |
| 840 | fix: release Windows ACL temp-path memos | Ingwannu | yes | +181/-10 | self (draft) |
| 839 | fix(providers): Claude 4.6/4.7 1M context windows | MilkClouds | no | +8/-1 | none (coderabbit major) |
| 837 | fix: integrate hosted image tool preferences | Ingwannu | no | +819/-18 | self (supersedes #616) |
| 812 | feat(providers): add Apertis preset | theQuert | yes | +224/-6 | Ingwannu CHANGES_REQUESTED |
| 811 | feat(remote): signed cross-platform agents | Ingwannu | yes | +15351/-12 | self (draft) |
| 746 | fix(providers): route Copilot Responses-only models off chat completions | mushikingh | no | +622/-21 | lidge-jun, Wibias commented |
| 744 | fix(providers): keep Antigravity catalog static | luvs01 | no | +702/-29 | Ingwannu APPROVED / lidge-jun CHANGES_REQUESTED |
| 715 | feat(codex): selection order for the account pool | XertroV | no | +3827/-191 | lidge-jun commented (implements #821) |
| 707 | security: harden post-merge service/management boundaries | LeoWang331 | yes | +7928/-594 | lidge-jun commented |
| 693 | feat(quota): report A6API credit usage | byongshintv | no | +371/-9 | lidge-jun CHANGES_REQUESTED |
| 671 | feat(codex): exact account routing | chrisae9 | no | +1213/-100 | lidge-jun commented |
| 653 | feat(providers): Baseten Model APIs preset | olddonkey | no | +403/-11 | Ingwannu APPROVED / lidge-jun CHANGES_REQUESTED (stale) |
| 644 | fix(windows): follow active Codex home for tray listener | clover980805-creator | yes | +98/-782 | lidge-jun CHANGES_REQUESTED |
| 616 | fix: preserve hosted image tool preferences | Eleven-is-cool | no | +819/-18 | Wibias DISMISSED; superseded by #837 |
| 581 | zh-TW localization for GUI, README, docs | letr1n1ty | no | +5854/-157 | lidge-jun CHANGES_REQUESTED |
| 569 | post-sync readiness endpoint + bounded ocx ready wait | diegocantarero | yes | +2516/-36 | maintainer note (needs security review) |
| 557 | fix(update): harden npm cache recovery preflight logs | lidge-jun | yes | +3192/-97 | maintainer-authored draft (blocking note) |

## Deep-analysis agent results

Dispatched 2026-08-02 in two waves (gpt-5.6-sol, medium, priority tier),
each batch read-only with `gh` access. Results appended below per batch.

### Batch: issues 864/859/858/857/855/848 (newest bugs)

- 864 — solid report, likely-ocx, HIGH. Version bisect + rollback proof
  isolate a transport/final-event regression; turns stay permanently active.
  No maintainer answer yet. Action: fix-now.
- 859 — solid, likely-ocx, MED. Static Desktop alias registry unavailable in
  the serving process; synthetic alias reaches DeepSeek verbatim. No
  maintainer answer. Action: fix-now.
- 858 — solid, likely-ocx, HIGH. Cleanup selects/rechecks archived rows
  without reading `is_pinned`; credible permanent task-data-loss path. No
  maintainer answer. Action: fix-now.
- 857 — solid, likely-ocx, MED. Codex in-memory catalog causes drift; ocx
  advertises newer disk roster, only warns during sync. Action: investigate.
- 855 — solid, likely-ocx, MED. Merge logic treats removed-provider rows as
  foreign entries to preserve; ghost models + request-time failures. Action:
  fix-now.
- 848 — solid, confirmed by Ingwannu; focused PR #861 open per maintainer
  spec. Action: finish review of #861.

### Batch: issues 823/822/821/820/809/806/796/755/753

- 823 — design-blocked (needs documented upstream activation operation,
  opt-in, single-flight, output isolation). Value med. Design-first.
- 822 — design-blocked (authoritative freshness, idempotency, crash
  recovery, cancellation, redacted audit). Value high. Design-first.
- 821 — actionable, high. PR #715 implements; must follow #671, rebase, add
  combined selector regression, pass credential-selection review.
- 820 — tracking umbrella; PRs #840-#847 cover confirmed retention points;
  broader profiling remains.
- 809 — actionable, high. Maintainer accepted read-only data-plane route
  with admission + redaction + negative authz tests.
- 806 — actionable, high. Accepted bounded copy/help correction across UI,
  CLI, docs, locales.
- 796 — needs live Ark confirmation; candidate fix host-gated at 2eebd9268.
- 755 — maintainer tracking queue; keep.
- 753 — actionable, high. Root cause + phased plan + verification already
  specified by maintainer.

### Batch: PRs 853/850/847/845/844/843/841/840/839/837

- 853 — merge-candidate. CI green, bot findings addressed, Wibias verified.
- 850 — needs-author-work: localized docs inconsistent (ja/ko/ru).
- 847/845/844/843/841/840 — Ingwannu draft series, sibling one-commit drafts
  from same dev parent (not a stack; #844/#845 overlap Cursor surfaces).
  All conflict with current dev; need rebase + independent review. They
  bound confirmed #820 retention points but do not deliver #820's full DoD.
- 839 — needs-author-work: Sonnet 4.6 value conflicts with existing 200k
  generated-metadata contract; reconcile source of truth first.
- 837 — needs-author-work: conflicts with dev; unresolved wire-default and
  inherited-property findings. Supersedes contributor PR #616.

### Batch: PRs 653/644/616/581/569/557 (oldest)

- 653 — conditional merge-candidate. Mergeable, security-approved (Ingwannu
  APPROVED on current head), tested; still absent from dev. Audit correction:
  GitHub reviewDecision is still CHANGES_REQUESTED (stale lidge-jun review),
  so it awaits owner re-review/dismissal — not merge-ready as-is.
- 644 — close-or-defer: invalid repro, no regression coverage, unrelated
  scheduler hunk regresses dev.
- 616 — close-or-defer: implementation accepted but moved into #837.
- 581 — needs-author-work: conflicts would delete revived workspaces; needs
  parity check, builds, rendered smoke, native-speaker review.
- 569 — needs-author-work: sound design; needs rebase, ready transition,
  fresh CI, independent review of unauthenticated endpoint.
- 557 — needs-author-work: live whitespace-path redaction leak +
  non-mechanical conflicts + mandatory security review.

### Batch: PRs 868/866/865/863/862/861/860/854 (newest)

- 868 — needs-author-work: focused Windows scheduler race fix; ownership-loss
  edge test open, full platform CI not run.
- 866 — merge-candidate. Fail-closed reset-eligible quota-rejection
  classifier (first slice of #657); full CI green, bounded body handling,
  focused tests. No maintainer review yet.
- 865 — build-ourselves-worthy. Opt-in same-target 429 wait-and-retry before
  key failover (#487); strategically valuable proxy behavior, extensive
  tests, but 1,965 lines across 37 files needs full CI + maintainer
  architecture review. 20 historical bot findings (worst Critical) all
  resolved by author.
- 863 — build-ourselves-worthy. Encrypted native main profiles (implements
  #656); valuable, but 2,479 lines, new native keyring dependency, 401-line
  vault module — requires explicit security + design review.
- 862 — merge-candidate. Docs-only pool-routing semantic correction synced
  across UI/locales; full CI green; bot findings resolved.
- 861 — needs-author-work: implementation mature (follows Ingwannu's #848
  spec) but macOS CI failure must be diagnosed/proven unrelated.
- 860 — merge-candidate. Gates OpenAI-only `service_tier` by provider
  capability (fixes DeepSeek breakage); coherent fix; run full CI before
  landing.
- 854 — merge-candidate. Minimal correction honoring authoritative context
  windows in generated Claude profiles; regression test included; full CI is
  the final gate.

### Batch: issues 695/658/657/656/586/572/561/553/545/540

- 695 — needs-info: maintainer needs triggers, affinity rules,
  unknown-quota handling, generic-pool scope. Value med.
- 658 — actionable, high. Maintainer accepted registry-gated compat
  capability with fail-closed behavior + regressions. Implement-soon.
- 657 — design-blocked umbrella; PR #866 is the accepted first slice;
  redemption/waiting/lifecycle remain separate (#822 overlap).
- 656 — design-blocked; draft PR #863 needs credential-lifecycle + security
  review.
- 586 — design-blocked: backend exists; canonical UI location undecided.
- 572 — tracking umbrella; shared safe-discovery infra landed via #652;
  keep open for small verified batches.
- 561 — needs-info: Modelsell exists, but maintainers require API docs,
  legal entity/resale authorization, verification date, named maintainer.
- 553 — needs-info: evidence implicates VPN fake-IP interception; #575
  fixed attribution; clean-network retest needed before close.
- 545 — design-blocked: no safe proxy fix without changing caller limits /
  OAuth identity semantics / incomplete-response handling. Value high.
- 540 — tracking: blocked on Automattic authorization + sanctioned
  OAuth/gateway contract.

### Batch: PRs 812/811/746/744/715/707/693/671

- 812 — needs-author-work: Apertis preset; rebase resolved, but confidential
  routing/resale authorization needs maintainer verification pre-security.
- 811 — needs-author-work: 15k-line signed-agents draft unreviewable as one
  unit; Windows Rust builds use Unix-only APIs; GUI tests fail; conflicts.
- 746 — needs-author-work: correct Responses-only Copilot routing; P2
  catalog/selector findings, rebase, credential-replay security approval,
  CI rerun.
- 744 — needs-author-work (audit correction, was "closest merge-candidate").
  Live state UNSTABLE: Ubuntu/Windows checks fail; reviewDecision remains
  CHANGES_REQUESTED; current head 746edc7 is newer than Ingwannu's approval
  on fa6b3ef. Fix current failures, obtain review on current head,
  resolve/dismiss the stale change request.
- 715 — needs-author-work: LAND-AFTER #671; rebase over GUI conflicts; add
  exact-selector bypass regression; resolve P2s; security review.
- 707 — close-or-defer: #697 landed first tranche; 8k-line follow-up
  conflicted, spans multiple threat models, unresolved credentialed-probe
  P1s — replace with focused PRs (controls individually valuable).
- 693 — needs-author-work: malformed success response preserves stale
  last-good credit data; separate terminal-invalid vs transient failures
  with state-transition regression.
- 671 — needs-author-work: code accepted; needs explicit credential-
  selection security sign-off + resolve/falsify account-context/docs P2s.
  Land before #715.

### Batch: issues 425/418/417/415/414/386/241/201/178/177/95/92 (oldest)

- 425 — actionable, high. Design accepted; namespace foundation landed;
  green PR #671 implements exact-account routing.
- 418 — needs-info: one same-run three-boundary `spawn_agent` trace needed
  to assign provider emission vs proxy translation vs Codex lifecycle.
- 417 — upstream-blocked. Relay tests exonerate ocx; openai/codex#35161
  OPEN.
- 415 — design-blocked: needs capability/citation/auth/quota matrix first.
- 414 — actionable, high. Exa-first scope concrete behind existing sidecar
  backend config.
- 386 — actionable, med. Superseded by maintainer branch `feat/macos-app`;
  finish review + CI artifact proof + release integration.
- 241 — upstream-blocked: Desktop remote native-only allowlist filters a
  correct catalog; no linked upstream ticket exists.
- 201 — needs-info: TRAE International exists but enterprise page still
  says CLI "coming soon"; no sanctioned international inference/auth API
  (verified 2026-08-02 via trae.ai/enterprise).
- 178 — design-blocked: Factory's Droid Exec is an agent backend, not a
  model-inference provider.
- 177 — design-blocked: Warp's Oz API launches environment-backed agents,
  not selectable model inference.
- 95 — tracking roadmap item (tenant isolation, attribution, load).
- 92 — upstream-blocked. Note: the openai/codex#32453 cited earlier in the
  thread is OPEN but concerns unrelated stale-model compaction/429
  behavior; the real encryption limitation has no linked upstream ticket.

## Independent spot-verification (web, 2026-08-02)

- Anthropic docs: Claude Sonnet 4.6 and Opus 4.7 both support the 1M-token
  context window (GA on the API). PR #839's intent is externally correct;
  the conflict is with the repo's generated 200k metadata contract, which
  must be reconciled as source of truth.
- openai/codex#32453 remains OPEN (unrelated to #92's encryption path).
- trae.ai/enterprise still lists CLI as "coming soon" — no sanctioned
  international API for #201.
