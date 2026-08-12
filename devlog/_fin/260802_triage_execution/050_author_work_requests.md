# 050 — Needs-Author-Work: Tailored Comment Plan (wp6)

21 PRs. Each gets a maintainer comment listing the concrete work required
before re-review, verified against the PR's current state by the dispatched
subagent (state may have moved since triage — re-check, then post). One
subagent per PR, waves of 6. English, constructive tone, numbered asks.

Core asks per PR (from the audited triage):

- 868: add the ownership-loss edge test (queueMicrotask ownership change
  between check and await resumption); run full platform CI.
- 861: diagnose or prove unrelated the macOS CI failure on current head.
- 850: sync the localized docs (ja/ko/ru) with the CORS exact-match change.
- 839: reconcile with the generated 200k metadata contract; note that
  external docs confirm Claude 4.6/4.7 1M context, so update the source of
  truth and tests together, not just the two literals.
- 837: rebase onto current dev; resolve the wire-default and
  inherited-property findings.
- 847: rebase onto current dev; request independent review (memory-bound
  series, #820).
- 845: rebase; coordinate with #844 on the shared Cursor transport/docs
  surface (order or merge the two).
- 844: rebase; coordinate with #845 (same surface).
- 843: rebase; independent review.
- 841: rebase; independent review.
- 840: rebase; independent review.
- 812: provide the Apertis routing/resale authorization evidence required
  for a canonical preset (contributing-guide evidence bar) before security
  approval.
- 811: split the 15k-line draft into reviewable units; fix Unix-only APIs
  in the Windows Rust build; fix GUI test failures; rebase.
- 746: resolve the P2 catalog/selector findings; rebase; obtain
  credential-replay security approval; rerun CI (Windows Bun crash).
- 744: fix the failing Ubuntu/Windows checks on current head; re-request
  review so the stale change request can be resolved (approval predates
  current head).
- 715: wait for #671 to land, then rebase over the GUI conflicts, add the
  exact-selector bypass regression, resolve P2s, and request security
  review.
- 693: separate terminal-invalid from transient failures so a malformed
  success response cannot preserve stale last-good credit; add a
  state-transition regression; rerun CI.
- 671: obtain explicit credential-selection security sign-off; resolve or
  falsify the account-context/documentation P2 findings.
- 581: resolve conflicts by translating the revived workspace vocabulary
  (not deleting it); run locale key-parity, GUI suite + build, /zh-tw docs
  build, one rendered language-switch smoke test; arrange a Traditional
  Chinese speaker review.
- 569: rebase, mark ready for review, fresh CI; the unauthenticated
  readiness endpoint needs independent security review.
- 557: fix the whitespace-path redaction leak; resolve the non-mechanical
  conflicts; mandatory security review (update/recovery surface).

## Results (2026-08-02, wp6 executed)

All 21 tailored comments posted via subagent waves (each agent re-verified
current PR state before posting):

| PR | Comment | PR | Comment |
|---|---|---|---|
| 868 | 5154157722 | 840 | 5154166384 |
| 861 | 5154156466 | 812 | 5154165787 |
| 850 | 5154157071 | 811 | 5154172223 |
| 839 | 5154156617 | 746 | 5154172627 |
| 837 | 5154156992 | 744 | 5154172093 |
| 847 | 5154155851 | 715 | 5154172245 |
| 845 | 5154165556 | 693 | 5154172239 |
| 844 | 5154165585 | 671 | 5154172192 |
| 843 | 5154165434 | 581 | 5154177192 |
| 841 | 5154166236 | 569 | 5154177408 |
| 557 | 5154177093 | | |
