# 002 — Corrected baseline on the pinned runtime (`bun 1.4.0`)

> **PARTIALLY SUPERSEDED by `007_acl_defect_retracted.md`.** The shard counts
> below are the raw measurement and stand. The DIAGNOSIS does not: the 22
> shard-2 failures attributed here to an ACL-seam defect were contamination
> from a killed 1.3.14 run, proven by a probe that stubbed both `icacls`
> runners and logged zero invocations while the failures persisted. On a clean
> tree that file is 22 pass in 1.4s.
>
> Read `007` before using anything in this document. Every "three defects" and
> "defect 2" reference below should be read as **two** defects; phase `010` and
> its follow-up `040` are retracted.

Same box, same checkout, same serial lock. The only change from `000` is the
binary: `./node_modules/bun/bin/bun.exe` (1.4.0, the version `package.json:68`
pins) instead of the 1.3.14 on `PATH`.

## Shard 1/4

```
4459 pass · 39 skip · 2 fail · 128135 expect() calls · [971.45s]
```

**52 → 2.** The 50 that disappeared were the 1.3.14 isolate fault (`001`), not
defects in this repository. Both survivors are in one file:

```
(fail) ocx v2 keep-native-v1 > enabling the native-v1 pin disables the global V2 override before catalog sync
(fail) ocx v2 keep-native-v1 > mode v2 honors a pre-existing native-v1 pin instead of enabling the global override
```

Shards 2-4 are running and land in the table below as they finish.

| shard | pass | skip | fail | wall |
|---|---|---|---|---|
| 1/4 | 4459 | 39 | **2** | 971s |
| 2/4 | 4606 | 16 | **22** | 1147s |
| 3/4 | 4305 | 11 | **1** | 1274s — **past the 1.3.14 wedge** |
| 4/4 | 4413 | 12 | **0** | 888s |
| **total** | **17783** | **78** | **25** | 4280s |

## What the corrected baseline says

| | first attempt (1.3.14) | corrected (1.4.0) |
|---|---|---|
| shard 1 | 52 | 2 |
| shard 2 | 122 | 22 |
| shard 3 | no verdict (wedged) | 1 |
| shard 4 | 5 | 0 |
| **defects** | unknowable | **3** |

25 failures, three root causes, and one of them is a single file. Shard 4 —
which `000` reported as five failures including two that looked like a
containment breach at `tests/service.test.ts:1283` — is **completely green**.
That alleged breach was the 1.3.14 guard fault, not a real hole in the armed-test
refusal.

### The three defects

| # | failures | file | mechanism | doc section |
|---|---|---|---|---|
| 1 | 2 | `tests/multi-agent-keep-native-v1.test.ts` | `.cmd` shim argv used as a mock API | "The one real defect so far" |
| 2 | 22 | `tests/oauth-store-multi.test.ts` | async `icacls` seam left unstubbed (+8 exposed siblings) | "The second real defect" |
| 3 | 1 | `tests/update-notify.test.ts` | POSIX unlinked-cwd is unreachable on Windows | "The third real defect" |

All three are **test-harness defects**. **No product defect was identified**, and
that phrasing is deliberate: `src/lib/win-exec.ts` is verifiably correct and is
what defect 1 trips over, `src/lib/windows-secret-acl.ts` offers the async seam
defect 2 forgot to use, and defect 3 asks the filesystem for something Windows
does not provide. What the evidence supports is "no product defect identified;
the failures point at harness teardown" — not the stronger claim that none can
exist. `010` carries the red/green A/B that would upgrade or refute that for
defect 2.

So the unit is "three fixtures encode POSIX assumptions", not "Windows is
broken".

### Sequencing: the three phases are INDEPENDENT

An earlier draft called this a dependency chain (2 → 1 → 3). It is not, and
describing risk ordering as dependency was wrong: defect 1 and 3 consume nothing
from the ACL helper, and defect 2 touches neither `src/cli/v2.ts` nor
`tests/update-notify.test.ts`. Disjoint write sets, no shared API.

They may be built and reviewed in parallel. If they are published as a stack it
is for review convenience only, and the order is then by size — `010` (22
failures), `020` (2), `030` (1) — which is a presentation choice, not a
constraint.

Shard 2's 22 are one file, `tests/oauth-store-multi.test.ts`, and one mechanism.
The 122 failures `000` recorded for this shard are gone: the 68 recovery and 49
fabric guard failures do not exist on the pinned runtime.

### Where the implementation plans live

This document is research: the raw baseline, plus a root-cause roll-up whose ACL portion is retracted by 007. One diff-level
document per surviving phase, each independently landable:

| doc | defect | failures | files touched |
|---|---|---|---|
| `010_defect_acl_seam.md` | half-installed ACL stub seam | 22 | `tests/helpers/windows-secret-acl-stubs.ts` (new), `tests/oauth-store-multi.test.ts` |
| `020_defect_launcher_argv.md` | launcher argv used as a mock API | 2 | `tests/multi-agent-keep-native-v1.test.ts` |
| `030_defect_unlinked_cwd.md` | POSIX unlinked cwd unreachable | 1 | `tests/update-notify.test.ts` |

No product source file appears in that table.

## Evidence

Shard logs are retained at `.tmp/win/v140-{1,2,3,4}.log` (gitignored; 603KB,
661KB, 597KB, 646KB). `grep -c '^(fail)'` over them gives 4, 44, 2, 0 — twice
the reported per-shard counts for 1-3 because Bun prints each failure once
inline and once in the trailing summary, and 0 for shard 4 either way.

**Shard 3 clears the wedge.** `030` predicted this from the pair experiment;
the full shard confirms it in situ:

```
1227:tests\client-hub-relay.test.ts:
1235:tests\cline-pass-reasoning-efforts.test.ts:
```

Eight log lines apart. On 1.3.14 that boundary consumed 14 minutes and never
produced a second file. No code changed in between — only the runtime.
