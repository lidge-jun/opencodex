# wp15 — #2495 + PR #2496 opt-in plaintext V2 collaboration rewrite

Investigation (grok subagent James): head e4b88af4f, 14 ahead / 4 unique vs dev, +2729 / 18 files, draft,
CHANGES_REQUESTED on an older head, exact-head CI blocked on fork approval; last executed suite red on
two PR-specific assertions (plaintext alias rebuild after quota retry; WS relay rewrite). Depends on
undocumented ChatGPT/Codex behavior (reserved namespace/tool renames to defeat Fernet encryption;
`encrypted_function_args: []` receive path). Core-lab boundary clean; no body logging.

## Disposition
Close PR #2496 with rationale; keep #2495 open with the reopen conditions. Not merged: protocol rewrite
keyed off undocumented upstream behavior, no exact-head green, reviewer blockers not re-reviewed, and a
smaller slice would not close the issue. Estimated honest merge path 8–12h with a maintainer-owned
rebase and security pass; not this batch.

## Executed
PR #2496 closed 2026-09-02 with the rationale above; #2495 commented with reopen conditions
(maintainer-owned rebase, exact-head green run, security pass on plaintext retention).
