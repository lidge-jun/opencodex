# Non-bug adoption backlog — scope

Fifteen non-bug items selected from the open issue/PR set by the maintainer's own
recorded `우선순위 NN / 80` review scores. Excludes every `bug`-labeled item,
maintainer-authored items (#3158, PR #3061, PR #2783), and #3146 (already closed by
PR #3151).

One work-phase per item, highest score first, except where a smaller verified diff
is sequenced earlier to establish the landing pattern.

| wp | Item | Score | Existing PR |
|----|------|-------|-------------|
| wp1 | #2731 adaptive reasoning effort | 62 | #2734 (draft) |
| wp2 | PR #3142 + #2511 oversized body refusal | 64 | #3142 (ready) |
| wp3 | #2901 compaction provider selection | 58 | none |
| wp4 | #1690 retainModels allowlist | 58 | #2122, #2860 (rival) |
| wp5 | PR #2986 xAI Imagine relay | 58 | #2986 (ready) |
| wp6 | #1107 authless Codex Desktop routing | 71 | none |
| wp7 | #2713 shim-free token injection | 58 | none |
| wp8 | #1525 Windows proxy auto | 60 | none |
| wp9 | #1221 OS keychain provider keys | 61 | none |
| wp10 | #2201 model display names | 60 | #2715, #2716 |
| wp11 | #1082 per-account Gem/Cla quota | 63 | #2123 |
| wp12 | #695 generic OAuth pool failover | 69 | none |
| wp13 | #822 reset-credit auto-redemption | 59 | none |
| wp14 | #2816 upstream Responses WebSocket | 59 | #2817 |
| wp15 | #2495 plaintext V2 collaboration | 65 | #2496 |

## Standing constraints

- Never run the local suite. Focused typecheck only, and only when cheap.
- Push `--no-verify`; merge with admin authority; CI is trailing evidence.
- Every capability is opt-in and defaults to today's behavior.
- The opt-in must be discoverable where a user already looks for that concern.

## The UX rule that decides these

A capability whose only surface is a hand-edited `config.json` key is not
discoverable. When the concern already has a dashboard editor, the opt-in belongs
in that editor — and it must survive a round-trip through it. A field the GUI
silently drops on save is worse than no field, because the user sees their setting
disappear with no error.
