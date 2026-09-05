# 007 — RETRACTED: the "ACL seam" defect never existed

22 of the 25 baseline failures were not a defect in this repository. They were
contamination I created, and the diagnosis I built on them was wrong.

## The claim

`002` and `010` said: `tests/oauth-store-multi.test.ts` stubs only the
synchronous `icacls` runner, so a real `icacls.exe` holds the fixture directory
and `removeTreeWithRetry` exhausts its 50 retries with EPERM. It matched the
corpus case `async-child-holds-dir-after-stop` exactly, and the code path was
verified reachable: `getCredential` → `hardenConfigDir` (`src/config/paths.ts:31`)
→ `hardenSecretDirAsync` → `asyncIcaclsRunner`.

Reachable is not the same as reached. `010` said so, and made the first
implementation step a falsification test. That test fired.

## The measurements that killed it

On the box, pinned runtime, one file at a time:

| probe | result |
|---|---|
| stub BOTH icacls runners via `--preload` | still 22 fail |
| log every runner invocation to a file | **0 lines** — `icacls` never ran |
| also stub both `windows-user-principal` runners | still 22 fail, still 0 invocations |

A mechanism that never executes cannot be the cause. Every claim in `010` about
`icacls.exe` holding the directory was false.

## What actually held it

`tests/.tmp-oauth-store-multi-test/auth.json`, timestamped **00:44** — from the
1.3.14 baseline, hours earlier. At 01:08 I sent `kill -9` to the wedged shard-3
process (PID 1382, `001`/`005`).

**Something left by that killed run held the directory**, so every later
`beforeEach` in the fixture hit EPERM until the leftover was removed by hand.

What the evidence does NOT establish is WHO held it. An earlier draft of this
document said the dead process kept its own handle; that is wrong — Windows
closes a terminated process's handles. The candidates that remain — a surviving
descendant of the killed shard, an indexer or antivirus scanner that opened the
file, or a delete pending on a handle closed later — were not distinguished,
because no handle-owner snapshot was taken before the directory was deleted.
Taking one (`handle.exe`, `openfiles`, or Resource Monitor) is what a future
occurrence should start with.

What IS established: the killed run is the origin (the debris carries its
timestamp), `icacls` is not the mechanism (0 invocations with both runners
stubbed), and the file is green once the debris is gone.

After deleting the leftover:

```
$ ./node_modules/bun/bin/bun.exe test --isolate --timeout 60000 tests/oauth-store-multi.test.ts
 22 pass · 0 fail · 71 expect() calls · [1404.00ms]
```

1.4 seconds, from 115 seconds and 22 failures. And recreating the leftover
directory and file WITHOUT a holder still passes — so the debris was never the
problem either. The dead process's handle was.

## Corrected failure count

| defect | failures | status |
|---|---|---|
| `.cmd` launcher argv as a mock API | 2 | REAL — reproduced clean |
| POSIX unlinked cwd on Windows | 1 | REAL — reproduced clean |
| ~~ACL stub seam~~ | ~~22~~ | **RETRACTED — self-inflicted** |

Verified together on a clean tree:

```
$ bun.exe test --isolate --timeout 60000 \
    tests/multi-agent-keep-native-v1.test.ts tests/update-notify.test.ts
 29 pass · 3 fail · [8.08s]
```

**The Windows suite has three real failures, not 25.**

## What this retracts

- `010_defect_acl_seam.md` — the whole phase. No helper, no fixture change.
- `040_acl_stub_hygiene.md` — the hygiene rule and its 18-file migration. It
  would have rewritten 18 test files to prevent a defect that does not exist.

## Why I believed it

The symptom matched a corpus case precisely, and the corpus is good, so I
classified instead of measuring. I checked that the ACL path *could* run and
treated that as proof it *did*. Three audit rounds did not catch it either —
the reviewers challenged the fix's shape, the evidence retention, and the
wording of the conclusion, and all of that was useful, but none of it could
substitute for running the thing.

The one thing that did catch it was a falsification condition written into the
plan before implementation, with the instruction to restart from the log rather
than patch. It cost one probe to find out, after roughly three hours of planning
built on top of it.

## Operational lesson, now a rule for this unit

**A killed suite run contaminates the next one.** `kill -9` on a Bun test process
leaves debris that something on the box may still hold — the mechanism was not
identified, and the practical rule does not depend on identifying it. Before any
measurement that a conclusion depends on:

```bash
cd /c/ocxwin/repo && git status --short          # leftover tests/.tmp-* dirs?
ls -d tests/.tmp-* 2>/dev/null                   # remove before measuring
ps | grep bun                                    # no survivors from a prior run
```

Two more leftovers exist right now (`tests/.tmp-api-catalog-route-9092`,
`tests/.tmp-issue-914-test`) and must be cleared before the confirmation runs.

The shard-2 count in `000_plan.md` and `002` is therefore also suspect: it was
measured after the kill. The confirmation baseline re-measures it on a clean
tree.
