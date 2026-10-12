# 260927 release 2.68.0 — plan

## Reader summary

The owner asked (2026-09-27) for a main..dev regression review with astra reviewers, for the
Windows/Linux tray to gain the menu bar patches the macOS panel received, and for a full 2.68.0
release. `origin/main` is v2.67.0 (`4bc92294aa`); `origin/dev` (`dc784d3e6f`) carries 86 commits
beyond it. Procedure follows [the 2.67.0 round](../../_fin/260926_release_2670/020_wp3_release.md);
only values differ. The owner asked for CI to be judged heuristically: a failure is a blocker only
when it reproduces or is tied to a change in the range.

## Work-phase map

| wp | Doc | Change |
|---|---|---|
| wp4 | [010](010_wp4_blockers_and_tray.md) | release blockers from the review, Windows tray parity |
| wp5 | [020](020_wp5_release.md) | candidate CI, pre-move to 2.69.0, promotion, publish, verify |

## Review lanes (astra, read-only)

| Lane | Range | Verdict |
|---|---|---|
| #6040 citation filter | `a1285fc648` | OK (700,168 comparisons) |
| #6045 visualization references | `dc784d3e6f` | OK |
| dev sanity + CI classification | whole range | OK; Devin test mock leak (test-only) |
| merge trains 1-5 | #5901..#5909 | OK |
| desktop, batches 6-8 | #5910..#5957 | BLOCK: native tray `switchFailed` cached |
| Kiro series | #5967..#6016 | BLOCK: first discovery failure never backs off |
| batches 9-10 | #5984..#6031 | BLOCK: Home-initiated Remote Link answers 503 |

Owner disposition for the Remote Link finding (2026-09-27): keep 2.67.0 behaviour for Home-initiated
links only; Child-initiated links keep the new ownership proof.
