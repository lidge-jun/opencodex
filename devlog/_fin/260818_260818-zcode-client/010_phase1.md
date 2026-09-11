# 010 — implementation record

Executed as one PABCD cycle (session cli, goalplan add-zcode-client-...).

- A-gate: grok-4.6 auditor round 1 FAIL (private RMW / secret-on-disk / byte-for-byte
  / show-dumps-keys) -> plan rev 2 -> round 2 PASS.
- B: commit 1ec6c8d65 (registry + builder + CLI alias + GUI lists + tests).
- C review: grok-4.6 reviewer FAIL (GUI page maps missing -> gui tsc red; guessed
  limit.output; --json-before-verb; CLI untested) -> commit 7668adf9a -> re-review PASS.
- Live E2E: real applyIntegration wrote 21 catalog models into ~/.zcode/v2/config.json;
  ZCode 3.7.7 picker shows OpenCodex/<provider>/<model>; marker prompt round-tripped
  via anthropic/claude-fable-5 (usage.jsonl 490587->490594). Screenshots: 020 (GUI tab),
  021 (ZCode live response).
- Full suite: 13286 pass / 12 fail; the same failing files fail identically on clean
  origin/dev (11 fail + 1 error baseline) — pre-existing, environment-bound, none touch
  the zcode surface.

