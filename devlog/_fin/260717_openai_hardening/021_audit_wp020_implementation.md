# wp-020 implementation audit — GPT-5.6 Sol high/priority

## First verdict

NOT PASS. The independent reviewer found seven blockers:

1. combined scrub/unlink failures could retain secret bytes while reporting a zero-byte temp;
2. Multi `resolution:none` could bypass eligibility and reuse an unusable main token;
3. central Direct sidecar selection could accept a proxy admission bearer;
4. compact collapsed cooldown and expired affinity to 401;
5. marker-1 legacy-only repair could leave `defaultProvider=openai` without Direct;
6. internal sidecar auth resolved before exact search/image activation;
7. the combined gate leaked WebSocket registry state and omitted named adversarial cases.

## Repairs

- Added honest secret-residual fatal errors plus truncate/empty-overwrite and unlink retry state machines.
- Multi `none` now throws locally; expired, reauth-marked, and cooled main-only cases cover HTTP, compact, and real WS with zero upstream.
- Central sidecar selection skips Direct for admission-secret bearers; internal search and vision prove the bearer never reaches ChatGPT or the routed provider.
- Compact preserves typed 429/409/401 outcomes.
- Marker-1 legacy-only repair inserts canonical Direct and, for pool intent, canonical Multi; second projection is idempotent.
- Search and vision expose pure activation predicates, so auth/account selection occurs only for enabled, requested work on a non-passthrough route.
- WebSocket registry tests clear state after every case; configured Multi catalog activation, all seven management runtime fields, and explicit `pool` test arguments are covered.

## Local evidence after repair

- `bun x tsc --noEmit` — exit 0.
- Exact wp-020 command — 387 pass, 0 fail, 3692 assertions.
- Immediate second exact run — 387 pass, 0 fail, 3692 assertions.
- `git diff --check` — exit 0.

Final independent re-audit remains required before closing wp-020.

## Second verdict and repairs

The re-audit confirmed the original seven blockers were closed but found two remaining
medium blockers:

1. rollback cleanup could run twice, delete the temp on the second pass, and still
   return the first `OpenAiTierBackupSecretResidualError`;
2. read/create and initial atomic write/harden failures plus the complete reserved-tier
   management forgery matrix were not directly injected.

Repairs:

- `cleanupAttempted` gives exactly one layer ownership of backup temp cleanup. A reported
  secret residual now still exists with complete bytes, and tests lock exact unlink counts.
- Backup tests inject read/create/write/harden/publish failures and assert source bytes,
  no backup, no temp, and call order. Atomic tests directly trigger initial write and
  harden failures while preserving the destination.
- Management tests reject forged reserved-tier base URL, auth mode, model map, headers,
  capability metadata, all seven runtime fields, and the legacy `chatgpt` id.

Final Sol re-audit is required after the complete gate is rerun.

## Final verdict

PASS — the same GPT-5.6 Sol high/priority reviewer confirmed all findings closed.

Final fresh evidence:

- `git diff --check` — exit 0;
- `bun x tsc --noEmit` — exit 0;
- exact wp-020 26-file gate — 392 pass, 0 fail, 3,736 assertions.
