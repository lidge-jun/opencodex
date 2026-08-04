# 040 — Verify final tree and close goal criteria

## Commands

```bash
ls devlog/_plan | sort
ls devlog/_fin | rg '260723_codexrs|260723_issue_fixes|260722_star_surge|260722_issue_bug' || true
test -d devlog/_plan/260723_codexrs_realtime_subagent_devlog_sweep
rg -n "FINISHED|ACTIVE|AMBIGUOUS" devlog/_plan/260723_codexrs_realtime_subagent_devlog_sweep/020_inventory_matrix.md
```

## Capture

- Write `040_final_tree.md` with counted remaining `_plan` entries and moved names.
- Mark goalplan criteria with capturedEvidence paths.
- Local commit of devlog artifacts only if cleanly stageable; no push.

## Accept criteria

- Research unit complete.
- Inventory complete.
- Moves verified.
- Goal can be completed only when all four criteria have non-empty capturedEvidence.
