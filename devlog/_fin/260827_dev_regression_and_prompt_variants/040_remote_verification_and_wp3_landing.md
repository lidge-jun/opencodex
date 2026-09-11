# 040 — WP3 landing under remote-only verification

Supersedes 030's verifier block. 030 said "never the full suite locally"; the standing
instruction now says no bun test on this machine at all. Everything that executes tests
moves to lidge-ai, and the local box is reduced to editing, committing, and browser
inspection.

## Loop spec

- Archetype: verify-then-land. One work-phase, one PABCD cycle, terminal at a merged PR.
- Verifier: `ocx-run` on `lidge-ai` (16 cores, bun 1.3.14), measuring exit codes of the
  gate commands below. Not a win/lose oracle: it reports rc plus captured output, so C
  has real evidence rather than a claim.
- Stop condition: the base-variant PR is MERGED, `gh pr list --author lidge-jun` is empty,
  and `git rev-list --count` is 0 in both directions between `dev` and `origin/dev`.
- Expected terminal outcomes: merged (success) · remote gate red (fix, re-verify) ·
  `lidge-ai` unreachable (escalate, do not fall back to local).
- Escalation: a red gate that is NOT about this diff (a pre-existing `dev` failure) is
  recorded and reported, not silently absorbed into this PR.

## Current state, measured this phase

    branch codex/base-prompt-variants, 1 commit ahead of origin/dev (b715985ab)
    committed:  src/codex/prompt-layers.ts, src/server/management/codex-prompt-routes.ts,
                tests/codex-prompt-base-variants.test.ts
    uncommitted: 18 modified + 2 untracked, all under gui/
    local test processes: none (pgrep -fl "bun test" empty; the 10100 dev server,
                          pid 43702, is deliberately left running)

Three facts the harness has to work around, all measured rather than assumed:

- `lidge-ai` has no `~/bin/ocx-run` and no opencodex checkout. `scripts/OCX-RUN.md`
  documents the runner as "installed on lidge" — stale for this host. The runner script
  is in the repo (`scripts/ocx-run`, 146 lines), so installing it is a copy, not a rewrite.
- `~/ocx-promptset/repo` exists on that host, but its `origin` is a stale local bundle
  (`/tmp/promptset-full.bundle`) on branch `codex/codex-set-prompt-composer` with its own
  dirty tree. Reusing it would mix another unit's uncommitted work into this gate. A
  separate `~/ocx-verify/repo` is created instead, and the promptset directory is untouched.
- `git ls-remote https://github.com/lidge-jun/opencodex` succeeds from that host, so the
  branch travels over GitHub. No bundle transfer, no rsync of a dirty tree.

## Change map

### IN

| File | Change |
|---|---|
| `gui/**` (18 modified, 2 untracked) | already written; commit as-is with `--no-verify` |
| `devlog/_plan/260827_.../040_*.md` | this doc |
| `scripts/OCX-RUN.md` | correct the "installed on lidge" claim: name `lidge-ai`, and state that install is a copy of `scripts/ocx-run` when `~/bin/ocx-run` is absent |
| `.codexclaw/goalplans/.../{goalplan.json,ledger.jsonl}` | wp3 done, c5 met, evidence captured |

### OUT

- No new runtime code. The base-variant feature is already written; this phase verifies
  and lands it.
- No local `bun test`, no `bun run test`, no pre-push hook. Every commit and push is
  `--no-verify`.
- No worktree. Work stays in the `dev` checkout on branch `codex/base-prompt-variants`.
- `~/ocx-promptset` on the remote is not modified.

## The harness, exactly

    # one-time, on lidge-ai
    scp scripts/ocx-run lidge-ai:bin/ocx-run          # ~/bin, then chmod +x
    ssh lidge-ai 'git clone --branch dev https://github.com/lidge-jun/opencodex ~/ocx-verify/repo'
    ssh lidge-ai 'cd ~/ocx-verify/repo && bun install'

    # per verification round
    git push --no-verify -u origin codex/base-prompt-variants
    ssh lidge-ai 'cd ~/ocx-verify/repo && git fetch origin codex/base-prompt-variants \
      && git switch --detach FETCH_HEAD && bun install'
    ssh lidge-ai 'export PATH=$HOME/bin:$PATH
      nohup ocx-run gate ~/ocx-verify/repo 25m bash -lc "
        bun x tsc --noEmit &&
        (cd gui && bun x tsc -b --force) &&
        bun test tests/codex-prompt-base-variants.test.ts tests/codex-prompt-route.test.ts \
                 tests/codex-prompt-layers.test.ts &&
        bun test ./gui/tests/ &&
        bun run lint:gui &&
        bun run privacy:scan" > /dev/null 2>&1 &'
    ssh lidge-ai 'export PATH=$HOME/bin:$PATH; ocx-run status'
    ssh lidge-ai 'export PATH=$HOME/bin:$PATH; ocx-run tail gate 60'

`bun install` runs on the remote because `bun test` needs `node_modules`; the clone is a
fresh directory this phase creates, so the install has nothing of the user's to disturb.

The `25m` ceiling comes from `scripts/OCX-RUN.md`: the full suite is ~210s idle, and this
gate is a subset plus two typechecks. A TIMEOUT means investigate, not raise the number.

## Acceptance criteria

| # | Criterion | Proof |
|---|---|---|
| 1 | no test process runs on this Mac for this phase | `pgrep -fl "bun test"` empty before and after |
| 2 | remote gate green | `ocx-run status` reads `gate: OK rc=0`, with the tail captured |
| 3 | every commit and push bypassed hooks | `--no-verify` on each; no pre-push output in the transcript |
| 4 | the GUI PR carries its own inline screenshot | `pr-quality.cjs:527` arms from changed `gui/` paths; body contains the image |
| 5 | base row renders a real switch in the running dashboard | DOM dump of `#codex-set/prompt` shows `role="switch"` inside the base row |
| 6 | the dialog opens on the base row and steps variants | screenshot of the open picker with `n / total` visible |
| 7 | `base-instructions` is still not a boolean toggle | the remote gate includes `tests/codex-prompt-layers.test.ts`, which asserts `isToggleId(...) === false` |
| 8 | PR merged and dev synced | `gh pr view --json state` = MERGED; both `rev-list --count` = 0 |

Criteria 1 and 3 are the two the user has had to repeat, so they are written as gate rows
with their own proof rather than left as background discipline.

## Risk that is not mine to absorb

The remote clone starts from `dev`, so a gate failure that also reproduces on plain `dev`
belongs to `dev`, not to this branch. If that happens, the run is repeated on the `dev`
commit alone to separate the two, and the pre-existing failure is reported separately
instead of being fixed inside a base-variant PR.

