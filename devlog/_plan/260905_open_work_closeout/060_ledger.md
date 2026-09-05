# 060 — Merge ledger and closeout (append-only)

Rows are appended by each work-phase's D. Landing SHA proof: `git fetch origin dev &&
git merge-base --is-ancestor <sha> FETCH_HEAD` → exit 0.

| WP | Item | Disposition | Carry branch / PR | Head SHA | CI run id | Landing SHA | Ancestry proof (cmd + exit) | Original closed (comment URL) |
|----|------|-------------|-------------------|----------|-----------|-------------|-----------------------------|-------------------------------|

## Closure comments (issue/PR → landing SHA)

(none yet)

## Verifier policy

No repository-wide local suite was run in any phase; focused files, `bun run typecheck`,
`bun run test:changed`, and exact-head hosted CI only. Pushes use `--no-verify` because the
pre-push hook would run the forbidden suite.

## wp6 stop condition (authoritative)

Every LAND/REIMPLEMENT/IMPLEMENT row has a landing SHA with ancestry exit 0 and an
original-closure link (or an explicit keep-open rider: #3522, #3462); every DEFER/SUPERSEDED
has a closure or comment link; `bun run privacy:scan` exit 0 on the closeout commit; then the
unit moves to `devlog/_fin/`. The ledger header above is the single schema (010 §7 was aligned
to it in audit round 2).

