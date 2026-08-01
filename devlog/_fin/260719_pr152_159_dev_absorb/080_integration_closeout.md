# 080 — Integration closeout: full gates over the absorbed stack

## 1. Scope

After phases 010–070 have landed on `dev`, run the unit-wide gates and own any
cross-PR breakage repair. No new features; only integration repairs discovered
by the gates below. No push. This phase exists so no per-PR phase carries an
unrelated global gate (A-gate amendment 2026-07-19).

## 2. Gates

```bash
bun run typecheck          # root tsc (src/)
bun run test               # canonical isolated full suite (bun test --isolate ./tests/)
bun run privacy:scan       # secret/privacy scan (PR #153 fixtures in scope)
cd gui && bun run build    # GUI compilation owner
```

All four must exit 0 **in one contiguous all-green run on the same final HEAD**:
after ANY repair commit, all four gates re-run from the top — a pass assembled
from gate results at different commits does not count. Repairs are
maintainer-authored (Co-authored-by only if the repair reworks contributor
hunks).

## 3. Close-out contract

- Record fresh command outputs (exit codes, counts) in this doc at D.
- Update goalplan criteria cr1–cr7 `capturedEvidence` with per-PR commit SHAs +
  gate evidence; mark met.
- D summary states the terminal outcome per PR (DONE/NOOP) and archives the
  unit per repo convention (move to `devlog/_fin/` only when the whole unit is
  closed and the user approves the housekeeping).

## 4. D close-out (2026-07-19)

One contiguous all-green run on HEAD `dabf9de4`:

| Gate | Result |
|------|--------|
| `bun run typecheck` | exit 0 |
| `bun run test` (isolated full suite) | 3087 pass, 0 fail, 13372 expects, 268 files |
| `bun run privacy:scan` | passed |
| `cd gui && bun run build` | exit 0 |

No cross-PR breakage; zero repairs needed in this phase.

### Per-PR terminal outcomes (all DONE, landed on `dev`)

| PR | Commits on dev | Outcome |
|----|----------------|---------|
| #152 | `2435836d`, `5605c6e2`, `19d424ad` (Wibias) + `fec1e4c5` (repair) | DONE |
| #157 | `a676f80b` (maintainer redesign + Co-authored-by) | DONE |
| #156 | `a4086c87` (Wibias) + `29506b85` (repair) | DONE |
| #158 | `acca0e9a`, `b44355f7` (Wibias) + `120a652f` (repair) | DONE |
| #159 | `5ea37069` (Wibias) + `df0361dd` (repair) | DONE |
| #153 | `8af3166a`, `e3e11b56` (Wibias) + `70483eef`, `90d9a188` (repairs) | DONE |
| #154 | `bfdaa3e9` (Wibias) + `30782a87` (repair) | DONE |

Nothing pushed to any remote; GitHub PRs untouched (per goal scope).
