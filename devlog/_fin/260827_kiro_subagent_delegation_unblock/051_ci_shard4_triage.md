# wp3 — CI `test 4/4` triage (remote-only verification)

Unit: `260827_kiro_subagent_delegation_unblock` · work-phase `wp3` · C phase

All verification in this document was run on `ssh lidge-ai` at the user's
instruction. No local test run backs any claim here.

## Finding

**`test 4/4` fails on `dev` too. It is not caused by this branch.**

| checkout | commit | shard 4/4 | same file standalone |
|---|---|---|---|
| this branch | `ad1627d38` | **FAIL** — 148 pass / 68 fail, batch 5/20 | **68 pass / 0 fail** |
| `dev` | `b5563d438` | **FAIL** — 145 pass / 47 fail, batch 10/20 | **68 pass / 0 fail** |

Run on `/home/lidgeai/ocx-ci/opencodex` with the CI's own sharder,
`bash scripts/ci/run-bun-test-batches.sh 4/4`.

## Why this is a pre-existing batch-isolation defect

Three independent signals, none of which depend on trusting the branch:

1. **`dev` fails the same shard.** The baseline is red before any commit from
   this unit exists.
2. **Different batches, different counts.** The branch dies in batch 5/20 with 68
   failures; `dev` dies in batch 10/20 with 47, in a different suite (`CL-07 task
   effectiveness producer`). A defect introduced by this branch would not move
   the failure to a different batch and a different test family on `dev`.
3. **Every failing file passes alone.** `tests/codex-reset-credit-recovery.test.ts`
   is 68 pass / 0 fail standalone on BOTH checkouts. The failures only appear
   when the file shares a batch process.

One failure names the mechanism directly: *"refuses process-state reset without
the repository test preload"*. These are process-state-sensitive suites that
need a fresh process or a preload; a batch that co-locates them loses it. That is
the batching harness, not the Kiro adapter.

## This branch's own surface, verified remotely

```text
lidge-ai:/home/lidgeai/ocx-ci/opencodex  (ad1627d38)
bun test tests/kiro-adapter.test.ts
 68 pass
 0 fail
 331 expect() calls
```

## Disposition

Not fixed here, and not claimed green either. Repairing shard batching is a
repository-wide harness concern that predates this unit; folding it in would
silently widen a Kiro adapter PR into CI infrastructure work, and would make the
diff impossible to review as one change.

What this unit owes is honesty about it: the PR reports `test 4/4` red, states
that `dev` reproduces it, and gives the commands to re-run both sides.
