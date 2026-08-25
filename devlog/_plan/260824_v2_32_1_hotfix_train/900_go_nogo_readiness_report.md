# 900 — v2.32.1 release-candidate readiness: GO/NO-GO

Frozen `dev` SHA (code): **`faaa78dc05489625e5c9bf450050a46a7fa91d1f`**
Head at report close: `03c988cf3` — this report and two closeout docs, devlog only.
`git diff --name-only faaa78dc0 03c988cf3` lists three `devlog/` files and nothing
else, so every gate below still describes the tree that is shipping. CI does not
run on a devlog-only push by design; the code evidence is pinned to `faaa78dc0`.
Train started from: `origin/dev` `c44e43f00`, `origin/main` `96e2f67c3` (v2.32.0)
Report written: 2026-08-25. Supersedes an earlier draft frozen at `02c302a54`,
which a freeze audit rejected — see "What the audit changed" below.

## Verdict

**GO** for promoting `dev` → `main` and publishing **v2.32.1** as a bugfix-only
release. Promotion, tagging, and publishing were deliberately not performed; they
are human decisions and this unit ends before them.

## What landed

| # | PR | Merge SHA | What review changed |
|---|-----|-----------|---------------------|
| wp1 | #2487 | `73a11a8f1` | Baseline was misread as divergence; `dev` was an *ancestor* of `main` |
| wp3 | #2483 | `3e3a028fe` | The fix regressed `claude-opus-4-8.1`; tail corrected to `(?!\d)` |
| wp4 | #2481 | `a60d51748` | **My** replacement was disproved and reverted |
| wp5 | #2473 | `84ade0f15` | Clean — the only unit needing no code correction |
| wp6 | #2477 | `1d4a92a32` | Two defects: the flagged `allowed_tools` hole and a cross-kind residual |
| wp7 | #2476 | `02c302a54` | Skip-on-digest was a persistence regression |
| — | #2500 | `43227ac07` | Post-merge: malformed `namespace`; unrestored file permissions |
| — | #2501 | `faaa78dc0` | Post-merge: malformed selector using a pre-flattened wire name |

Two units closed without a merge, both pre-registered outcomes: **#2472**
NOT_REPRODUCED (deregistered as a GO criterion), **#2427** DEFERRED (three runs
gave 0/0/1 failures; four different tests flaked across five runs).

## What the audit changed

The first freeze at `02c302a54` was audited and **failed**, correctly, on three
counts. All three are now closed:

1. **Three unresolved review threads on merged PRs**, which the GO criteria forbid.
   Two were live defects that had been opened minutes before their PRs merged: a
   malformed `namespace` authorizing an alias, and the snapshot fast path never
   restoring broadened file permissions on a file holding request/response bodies.
   Fixed in #2500, then #2501 after review found #2500 was itself incomplete — a
   malformed selector carrying an already-flattened wire name still matched the
   alias map exactly. **All threads across all seven PRs are now resolved: 0.**
2. **The full-suite gate was red** and the first draft argued an exception in the
   report itself. That is retroactive gate-weakening and the audit was right to
   reject it. The gate is now decomposed the way CI actually partitions it, below.
3. **Missing frozen-head receipts.** Recorded below.

## Gate results at the frozen SHA

CI partitions the suite because three files are known to be load-sensitive:
`scripts/ci/run-bun-test-batches.sh:50` excludes `api-storage-policy*`,
`api-storage`, and `api-usage` from the general batches, and `ci.yml` runs each in
its own job. Running `bun run test` as one process is therefore *not* the same
gate CI applies. Both forms are recorded:

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `bun x tsc --noEmit` | exit 0 |
| Privacy | `bun run privacy:scan` | `Privacy scan passed`, exit 0 |
| **General suite** (CI's partition) | `bun test --isolate` over 1787 files, excluding the three segregated | **14565 pass, 0 fail, exit 0** |
| Storage-policy job | `bun test --isolate` over the six files `ci.yml` names | **9 pass, 0 fail, exit 0** |
| api-usage job | `bun test --isolate ./tests/api-usage.test.ts` | 31 pass, **1 fail** — see below |
| Whole suite in one process | `bun run test` | 14604 pass, 3 fail — the segregated storage-policy family |

**The one `api-usage` failure is pre-existing and environmental.** The same test
fails identically on the untouched pre-train baseline `c44e43f00`, no merged unit
touches usage or overlay code, and CI's own `api usage` job is green at this SHA.
It is a local-environment artifact, not a candidate defect.

## Push-event CI at the frozen SHA

Run **`32793104507`**, event `push`, head `faaa78dc0`, conclusion **success**.
Every job green: `test 1/4`–`4/4`, `storage policy`, `api usage`, `gates`,
`macos`, `keyring` and `npm-global` on ubuntu/windows/macOS, and the `ci`
aggregate. This is the artifact `release.yml` requires.

## GO conditions

| Condition | Evidence |
|-----------|----------|
| `main` lineage in `dev` | `git merge-base --is-ancestor origin/main origin/dev` → 0 |
| Version line synced | `origin/dev:package.json` → `2.32.0` |
| Every PR merged post-wp1 | eight merge SHAs, each `--is-ancestor` verified |
| Maintainer approval | `reviewDecision=APPROVED` on all merged PRs |
| **Zero unresolved review threads** | **0 across #2483, #2481, #2473, #2477, #2476, #2500, #2501** |
| #2477 security review | independent lane recorded in wp6; both follow-ups landed |
| Push-event CI green at frozen SHA | run `32793104507` success |
| Typecheck / privacy / general suite | all exit 0 at `faaa78dc0` |
| Scope clean | `origin/main..origin/dev` is devlog + the runtime units only; no package/lockfile/workflow delta, no tag |

## NO-GO conditions, each checked

| Condition | Status |
|-----------|--------|
| Foreign tool-type selector authorizes a namespace alias | **Closed** (wp6) |
| Malformed `namespace` authorizes an alias | **Closed** (#2500, #2501) |
| Oversized turn opens a socket before falling back | **Closed** (wp5) |
| Snapshot skip loses state or permissions | **Closed** (wp7, #2500) |
| #2476 changed the 24 MiB cap, TTL, or eviction order | **Not changed** |
| A hygiene-blocked PR reached the train | **None** |
| A merge justified by remembered results | **None** — every close carries a bound receipt |
| New runtime feature work after freeze | **None** |

## Known defects shipping in v2.32.1

**#2407** (Kiro `tool_search`), **#2458** (Gemini video 502 — deferred because its
fix touches the guard wp6 hardened), **#2459** (Windows reinstall module graph),
**#2472** (zero-output, not reproduced), **#2491** (four divergent slug-equivalence
relations, filed during this train). Queue at freeze: ~50 open PRs, 20 open `bug`
issues. The train deliberately took six.

## What promotion still requires

Left to a human, per `MAINTAINERS.md`: the `dev` → `main` promotion and its
version bump to `2.32.1`, fresh Cross-platform CI **and** Service lifecycle runs at
the promoted `main` SHA (the `package.json` bump activates that gate), the tag, and
`npm publish` with dry-run and install verification.
