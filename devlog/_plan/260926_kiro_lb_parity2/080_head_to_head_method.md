# 080 — Head-to-head result from the landed tree (method)

Layer 080 of `000_plan.md`. This method document rides in the 010 PR with the rest of the roadmap.
The result (`081`) is a separate final docs PR opened only after 070 has merged to dev, because
its input is the merged `origin/dev` SHA. Depends on 010–070 being merged to dev.

This document specifies how the result is written; the result itself is written only after the
last layer lands, so every opencodex claim cites merged code rather than a branch.

## File change map

| Path | Change |
|---|---|
| `devlog/_plan/260926_kiro_lb_parity2/081_head_to_head_result.md` | NEW, written from the landed tree |
| `docs-site/src/content/docs/reference/adapters.md` (Kiro section) | MODIFY only if a landed layer changed user-visible Kiro behaviour its own PR did not already document |

## Inputs

1. `git rev-parse origin/dev` after the 070 merge; record it in the header.
2. kiro-lb at `/tmp/kiro-lb` HEAD; if it moved past `bee73b3`, list the new commits touching
   `kiro/auth.py`, `kiro/device_login.py`, `kiro/account_manager.py`, `kiro/usage*.py`,
   `kiro/http_client.py`, `kiro/endpoints.py`, `kiro/model_catalog.py`, `kiro/store.py`
   (`git -C /tmp/kiro-lb log --format='%h %s' bee73b3..HEAD -- <files>`) and classify each.
3. Every row of `001_research_gap_inventory.md`.

## Required content of 081

- One table row per 001 row, same IDs, columns: axis, kiro-lb (file:line at the recorded HEAD),
  opencodex (path:line at the recorded dev SHA), verdict (`ahead-ocx`, `parity`, `ahead-lb`),
  and the regression test that proves the opencodex side (`tests/...` file and test name).
- Every **Adopt** row must end `ahead-ocx` or `parity` with a named test; a row that did not
  is a failed criterion (c-2/c-5), reported as such, never softened.
- Every **Reject** row repeats its reason from 001 and states whether it still holds at the
  recorded kiro-lb HEAD.
- A "Where kiro-lb still leads" section, listed plainly (expected: IDE wire fingerprint W1,
  extra endpoint dialects E1, paid endpoint probe E4, MCP web search S2, operations dashboard),
  each with the reason we chose not to follow.
- An "Evidence gaps" section: behaviours verified only against kiro-lb source and fixtures, not a
  live Kiro account (refusal reason strings in 030, catalogue fields in 050, social device-flow
  replies in 060, metering frames in 070).

## Verification

- `bun run privacy:scan` (exit 0) reads the new file (devlog is in its scan set per AGENTS.md).
- `bun run structure:check` (exit 0).
- Mechanical check: every test file named in 081 exists at the recorded SHA
  (`git cat-file -e <sha>:<path>` per path), and every 001 ID appears exactly once in 081.
- No kiro-lb text is quoted beyond identifiers and file:line anchors.

