# Phase 3 — Opt-in auto-cleanup policy (default OFF)

**Risk class:** C4 (builds on Phase 2 deletion). Separate PR. Default OFF.

## Goal
Optional, opt-in automatic cleanup so storage stays bounded without manual work.

## Policy shape
- Threshold: "archived > N GB".
- Target: "reduce to N GB" or "remove oldest N%".
- Schedule: startup / daily / weekly / manual.
- Deletion mode: quarantine (default) or permanent (explicit).
- Surface last-run / next-run + freed-bytes summary.
- Batch policy (not per-session prompts).

## Safety
- Inherits all Phase 2 safety: preview math, quarantine default, lock safety,
  full data-model reconciliation.
- Default OFF; never enabled implicitly.

## Verification idea
- Simulate policy against a fixture: correct selection, correct freed bytes,
  respects quarantine mode, no action when under threshold.

## Open questions
- Per-provider or global policy?
- Notify the user after an auto-run, or silent with a log entry?
