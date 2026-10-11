# 090 — Outcome

Delivered as one bundle PR into `dev` from `codex/lane-r3-l2-261011` (lane L2, round r3).

- Tier labels: alias tier slots OpenCodex writes are paired with `ANTHROPIC_DEFAULT_<TIER>_MODEL_NAME`
  on the `ocx claude` launch env, launchd system env and the shell hook file. This is the confirmed
  alias tier-row defect and the candidate explanation for #6926; the PR says "Refs #6926" because
  closure needs a `/model` observation on the reporter's tier slot.
- Inclusive Anthropic usage carried from #6566 (Co-authored-by: Foodcel); #6566 stays open for its
  usage-admission and stable-replay parts.
- #6532: no code change; its fixes (`0455845834`, `26dd8cf657`, `33125e62d2`) are on `dev`; it stays
  open for live multi-account acceptance (needs a real Claude OAuth pool).

Review: plan audit FAIL then PASS; final diff review FAIL (one P2, `--fast` labels) then PASS.
Local verification was static only (typecheck, structure:check, privacy:scan); hosted CI on the
exact PR head is the test evidence.

