# 090 — PR #317: fix(codex): classify monthly WHAM windows

- Appeared mid-review (branch `agent/fix-codex-monthly-window-315`, fixes #315).
- Base `dev` · +87/−13 · 4 files (`src/codex/quota.ts`, routing test, en/ko dashboard docs).
- CI: all green so far (checks still completing at capture time). No GUI paths.

## What it does

- Retains `limit_window_seconds` on WHAM usage windows.
- Classifies an explicitly-reported primary window ≥ 28 days (2,419,200s) as monthly instead
  of assuming primary = weekly; preserves secondary weekly fallback; duration-less payloads
  keep legacy weekly interpretation.

## Review findings

- Fixes a real Team-account misclassification (monthly quota shown as "Week").
- Backward compatible by construction: only an explicit ≥28d duration changes behavior.
- Tests cover weekly-primary, monthly-primary, monthly+secondary-weekly, and duration-less
  legacy cases. Decision-log comment explains the 28-day lower bound (calendar variance).
- ko docs updated alongside en — locale sync done properly.

## Verdict: **MERGE-READY** once remaining checks finish green.
