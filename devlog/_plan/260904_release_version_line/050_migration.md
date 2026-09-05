# 050 — Migration from today's real state

Not a phase; a record of exactly what the first release under the new ordering does,
from the state verified on 2026-09-04.

## 1. Starting state

```
dev      2.43.0                      25 commits ahead of main; main IS an ancestor
main     2.42.0                      tag v2.42.0 -> 48f818664
preview  2.43.0-preview.20260904     no v2.43.0-preview.* tag exists
npm      latest=2.42.0  preview=2.40.0-preview.20260902
```

`dev` at `2.43.0` outranks every tag, so the repository is currently green and needs
no preparatory commit.

## 2. The ordering

The pre-move must put `dev` **ahead of the version being released**, which means it
targets `N(X)`, not `X`. Releasing `2.43.0`:

```
1. decide X                                  2.43.0
2. pre-move dev to N(X)                      2.43.0 -> 2.44.0    [the one PR]
3. promote dev -> main                       main receives 2.44.0
4. release X from main                       release.ts sets main's package.json to 2.43.0
5. tag v2.43.0 published                     dev already at 2.44.0; never red
```

Step 4 lowers `package.json` on `main` from `2.44.0` to `2.43.0`. That is unusual
enough to have been flagged as a risk in an earlier draft; it is now **verified
safe**:

- `npm version 2.43.0 --no-git-tag-version` against a tree at `2.44.0` exits 0 and
  writes `2.43.0`. Probed directly on a scratch `package.json`. The
  `scripts/release.ts:559-573` bump therefore needs no change and no
  `--allow-same-version`-style flag.
- `assertChannelVersionMovesForward` (`:342-370`) compares `X` against the npm
  channel tip, not the tree: `2.43.0 > 2.42.0` passes.
- `assertUnusedReleaseVersion` (`:372-391`) checks npm/tag/release for `X`.
- `release.yml:175-184` compares the tree to `X` **after** the bump.
- The invariant on the release commit: `2.43.0` equals the new highest tag on the
  commit that tag names — legal via `tagPointsAtHead`.
- On `main` between step 3 and step 4 the tree says `2.44.0` with `v2.42.0` highest
  — strictly ahead, legal.

Every existing gate tolerates the sequence.

## 3. Releases that need no pre-move

The pre-move is required only when the release would otherwise leave `dev` at or
behind the new tag. After the above, `dev` carries `2.44.0` and:

| Release | `dev` outranks it? | Pre-move needed |
|---|---|---|
| `2.43.1` hotfix | `2.44.0 > 2.43.1` ✓ | no |
| `2.44.0-preview.20260910` | `2.44.0 > 2.44.0-preview.*` ✓ | no |
| `2.44.0` stable | `2.44.0 == 2.44.0` ✗ | **yes** -> `2.45.0` |

`decideDevVersion` already returns `changed: false` for the first two
(`scripts/bump-dev-version.ts:120-126`), so a dispatched pre-move in those cases is a
harmless no-op that opens no pull request.

## 4. The preview channel

Preview cuts continue exactly as today: `preview` carries the prerelease it is
publishing, and `release.yml:204-209` enforces the shape. The pre-move is normally
unnecessary for a preview (§3), because `dev`'s stable-shaped version outranks any
prerelease of the same core.

What `020` changes for previews is only how the *candidate* is computed: from the
stable line plus the preview tag set, never from the stale `preview` dist-tag alone.
Today that tag is `2.40.0-preview.20260902` while stable has reached `v2.42.0`, so a
channel-only computation could propose a `2.41.*` candidate behind a shipped stable.

## 5. The npm preview gap

npm `preview` is `2.40.0-preview.20260902`; the branch is at
`2.43.0-preview.20260904`; no `v2.41.0-preview.*` or `v2.42.0-preview.*` tags exist.
Either the last two preview cuts were abandoned mid-train, or previews stopped being
published. I could not determine which from the repository.

Neither reading breaks this design — §4 holds under both — but a maintainer should
decide it, because it determines whether the preview resolver in `020` is exercised
at all.

## 6. Rollout order

```
PR 1: 010    -> dev    behaviour-neutral, safe alone
PR 2: 020    -> dev    --bump only; no workflow coupling
PR 3: 030    -> dev    pre-move + readiness gate; independent of 020
      promote to main, release under the new ordering
PR 4: 040    -> dev    invariant case + docs, after one clean release
```

No two phases must land together. The atomicity constraint an earlier draft carried
existed only because of a dispatch input that no longer exists. `040` is the one
phase with two prerequisites: it documents the patch-line policy `020` implements
and the ordering gate `030` enforces, so it lands after both.

## 7. First release under the gate

`030`'s readiness gate requires `dev` to strictly outrank `X`. At step 4 above,
`dev` is `2.44.0` and `X` is `2.43.0`, so it passes. If the pre-move has **not**
merged, `dev` is `2.43.0`, the gate refuses, and the remedy is the pre-move itself —
which is the intended behaviour, not a migration obstacle.
