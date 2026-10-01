# 090 — outcome

All three layers of LilMGenius's omo (Codex / LazyCodex) series are on `dev`. Each landed as a maintainer carry PR with `Co-authored-by: LilMGenius <smsmeee@naver.com>`, in dependency order, and each was verified only by hosted CI at its exact head. The owner instructed that no local test suites be run.

| WP | Carry PR | Source | Squash on dev | CI run (exact head) | Security review |
|---|---|---|---|---|---|
| wp1 | #6366 | #6262 `ada7ec14b1` | `a6114b62ed` | 36834055042 @ `70f696593c` | FINDINGS (2) → fixed → PASS |
| wp2 | #6367 | #6269 `6c97ca9a4f` | `da13a02727` | 36861822233 @ `c721b63cb0` | FINDINGS (1) → fixed → PASS |
| wp3 | #6389 | #6274 `b180fcec0a` | `de8afe2e86` | 36863310320 @ `e29b86290c` | PASS, carry repair accepted |

## What changed beyond the contributor heads

- `70f696593c` (wp1): the role TOML must parse both before and after a model edit, otherwise the write is refused with `invalid_role_file`. Other write failures answer a fixed `write_failed` message with no path or UID.
- `30ae36a149` (wp2): auto-assign sizing failures now return only a category or a bare HTTP status (`publicSizingError`). The same commit clears two React Doctor warnings. A later fixture fix (`c721b63cb0`) satisfies the privacy scan.
- `881bb588f4` (wp3): the same sanitisation for delegation suggest.
- Union resolutions: wp2 `a0e3ac8d39` (the effort writer) was merged with the wp1 TOML validation. wp3 merged the label move with the module-scope `alreadySet`.

## What did not go to plan

- The first CI runs on wp2 failed twice, on React Doctor and then on the privacy scan. Both failures came from maintainer edits, not contributor code. Running React Doctor and the privacy scan statically before pushing would have caught them.
- An accidental trial cherry-pick in the main checkout ran against a stale local `dev`. It was aborted with no residue.
- The wp3 replay and repair happened before A instead of inside B. The FSM refused B→C for having no source delta, so this `_fin` move is wp3's B delta.

## Originals

#6262 (already closed), #6269 and #6274 were closed with links and credit. My `CHANGES_REQUESTED` reviews on all three were dismissed, citing the author's fixing commits.
