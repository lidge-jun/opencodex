# B9 — ephemeral picker CA key, and the round outcome

Base: `dev` `d0bec2a2b7` (after B8 #6071). Branch `codex/train3-b9`.

| Item | Plan |
|---|---|
| #6072 (luvs01) | Carry. The Claude Desktop picker CA keeps its signing key in memory only and publishes public material; rotation untrusts the old root from a private copy; `ocx claude desktop picker trust` verifies the file against the live server. Kimi security review: BLOCKER no. |
| #6072 follow-ups | Correct the `underPickerCaLock` comment, which claims a foreign certificate is never replaced although the fresh-authority fallback publishes without the lock. Remove a legacy `claude-picker/ca.key` at server start even when the picker is off, so an upgrade with the picker disabled does not leave the old key on disk. |
| Outcome | `090_outcome.md` records what landed, what closed, and every open item with its reason. |
