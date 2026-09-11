# wp4 — L2 lane outcome

#2663 landed on `dev` as `cebe005db` (PR #2724), squashed into `cb9bb9b76`.
The PR is CLOSED with a comment naming the sha.

## Squash fidelity was proven, not assumed

```
git diff 58f5a294e 71e182ae6  ->  pr.diff     (1087 lines)
git diff cb9bb9b76~1 cb9bb9b76 -> squash.diff (1087 lines)   IDENTICAL
git diff --stat 71e182ae6 cb9bb9b76 -- <12 files>   -> empty
git diff --stat 58f5a294e 64c6d642b -- <12 files>   -> empty
```

The last line is the one that mattered and would have been easy to skip: `dev`
moved 96 commits between the PR's merge base and the squash base, but touched none
of these 12 files. That is WHY a whole-take squash was safe here. Had any of those
files moved, the same procedure would have silently produced a different result.

## The guard question, answered properly

The reviewer's main line of attack was the right one: `rememberPassthroughResponseChecked`
now runs the undeclared-tool guard on a RESTORED response
(`src/server/responses/core.ts:3286-3299`), so restoration could in principle launder
an undeclared name into a declared one.

It cannot, and the reason is structural rather than incidental: restoration is strictly
NARROWER than the guard's own normalization. Both call `normalizeDeclaredToolName`
(`src/types/tools.ts:47`), and `routedCustomToolTargetName`
(`src/responses/custom-tool-compat.ts:70`) additionally requires the normalized target
to be in the routed set. Any name restoration rewrites was already declared-equivalent
to the guard.

Measured, guard verdict before vs after restoration:

| item | before | after | resulting name |
|---|---|---|---|
| `other_tool` | refused | refused | `other_tool` |
| `rm` | refused | refused | `rm` |
| `apply_patch` (helper) | accepted | accepted | `exec` |
| `namespace:"evil"` + `apply_patch` | refused | refused | `apply_patch` |
| `apply_patch_evil` | refused | refused | `apply_patch_evil` |

No row flips from refused to accepted.

## Helper matching is exact membership, and that was tested adversarially

13 hostile variants probed — `apply_patch_evil`, `evil__apply_patch`, `Apply_Patch`,
`apply_patch ` (trailing space), `apply-patch`, `tools.apply_patch`, `exec_commandX`
— all returned `target = undefined`. A substring predicate would have captured three
of them. Injection is closed the same way: `compileCodeModeHelperInput` serializes
every value with `JSON.stringify`, and hostile payloads (quote-escape, backtick/\${},
U+2028/2029, patch-body breakout) each compiled to exactly one `await tools.` call
with zero escapes out of the string literal.

## Test changes were repointed, not weakened

Every removed `apply_patch` refusal assertion is replaced by an equivalent
`other_tool` refusal — still-undeclared, so refusal coverage is preserved while
`apply_patch` becomes a recognized helper. The suite also gains bridged-turn
continuation, streamed bridging, and escape-resistance coverage.

Incidental find: `tests/bridge-legacy-shell-normalization.test.ts` fixes a latent bug
in its own helper (`delta:` -> `arguments:`). The old field was never read, so those
assertions were partly vacuous before.

## Evidence

- `bun run test` full suite: exit 0
- reviewer's independent run over 7 relevant files: 189 pass / 0 fail
- `bun x tsc --noEmit`: clean on the merged tree
- PR #2724 CI: 23/23 green after one rerun of the `update-stop-first` launcher flake
  (`git diff --name-only` vs dev shows NO_OVERLAP with any update/launcher file)
- VERDICT: PASS

## Incident: `core.bare` flipped mid-lane

After the merge, `git status` in the main checkout began failing with "this operation
must be run in a work tree" and `git worktree list` reported the repository as
`(bare)`. `git config --local --get core.bare` returned `true` while every tracked
file and `.git/index` were intact. Restored with
`git config --local core.bare false`; no data was lost and no commit was affected.
Cause not established — worth watching if it recurs while many worktrees are live.
