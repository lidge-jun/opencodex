# 030 — Execute safe _fin moves for FINISHED only

## Objective

Move only inventory rows labeled FINISHED. Leave ACTIVE/AMBIGUOUS.

## Algorithm

```bash
# for each FINISHED name:
if [ -e "devlog/_fin/$name" ]; then
  record CONFLICT / UNSAFE; skip
else
  mv "devlog/_plan/$name" "devlog/_fin/$name"
  verify ! -e plan && -e fin
fi
```

For stub files (not directories), same rule.

## Files

| Path | Action |
| --- | --- |
| `030_move_log.md` | NEW — per-move before/after evidence |

## Safety

- Never `rm -rf`.
- Never overwrite `_fin` destination.
- Never move nested git trees (`opencode-cursor`, `_chase`).
- Prefer `mv` within same filesystem.

## Accept criteria

- Move log lists each attempted move with result OK/SKIP/CONFLICT.
- Post-state: zero FINISHED rows remain under `_plan`.
- ACTIVE/AMBIGUOUS still under `_plan` or root.
