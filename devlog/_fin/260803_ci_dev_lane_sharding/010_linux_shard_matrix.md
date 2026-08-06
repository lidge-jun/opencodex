# Phase 1 — the job split: Linux shards, platform legs, aggregate gate

Consumes `000_plan.md` and `001_shard_evidence.md`. Companion document:
`011_platform_legs.md`, which specifies the two platform jobs this phase
creates. **They are one commit**, not two phases.

> **Amended after audit rounds 1 and 2** (`002_audit_synthesis.md`).
> Round 1: the GUI dependency install stays in the shard job (dropping it breaks
> the suite — proven, not argued), the gate parses results with `jq` instead of
> grepping pretty-printed JSON, and the `if` pin is a string.
> Round 2: the platform split merged into this phase, because splitting it was
> not implementable.

## Why this is one commit and not two

An earlier draft made "shard Linux" phase 1 and "move the platforms" phase 2,
on the reasoning that the aggregate gate should exist before any leg is
removed. That ordering cannot be implemented.

The current `test` job *is* the three-platform matrix (`ci.yml:114-145`):
Ubuntu, Windows, and macOS are `include:` entries of the job phase 1 replaces.
Rewriting it into an Ubuntu shard matrix therefore deletes the Windows and
macOS legs in the same edit — while phase 1's own text claimed those legs were
"untouched in this phase". The phase boundary described a state the workflow
cannot be in.

So the split is: **one commit turns one matrix job into five jobs** (four
shards + `gates`), **creates the two platform jobs**, and **adds the gate**.
Area scoping stays a genuinely separate phase, because it only adds conditions
to jobs that by then exist.

The original concern still holds and is still met: the gate lands in the same
commit as the leg removal, so no window exists where a check name disappears
without a stable one replacing it.

## File: `.github/workflows/ci.yml` — MODIFY

### 1a. Split the single `test` job into shards plus `gates`

The current job runs everything on all three OSes. The work divides into two
kinds: the *suite* (480 files, the expensive part, platform-independent in
practice) and the *gates* (typecheck, privacy scan, GUI lint/build, release
helper syntax, CLI smoke) which are fast and only need to run once.

Running the gates inside every shard would multiply ~2 minutes of fixed cost by
the shard count. So: shards run the suite, and one job runs the gates.

BEFORE (current `test` job header):

```yaml
  test:
    name: ${{ matrix.name }}
    needs: select-windows-runner
    runs-on: ${{ matrix.runner }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        include:
          - name: ubuntu
            runner: ubuntu-latest
          - name: windows
            runner: ${{ fromJSON(needs.select-windows-runner.outputs.runner) }}
          - name: macos
            runner: macos-latest
```

AFTER:

```yaml
  # The suite, split by file across four Linux runners.
  #
  # `bun test --shard=i/N` sorts test files by path and deals them round-robin,
  # so the split is deterministic: shard 3 of 4 covers the same files on every
  # run, and the four shards together cover the suite exactly once. Verified on
  # this suite at 120 files per shard, union 480, no overlap.
  #
  # Only the suite lives here. Typecheck, lint, build, and the scans run once in
  # `gates` rather than four times — they are fixed cost, and paying it per shard
  # would eat what the sharding saves.
  test:
    name: test ${{ matrix.shard }}/4
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7

      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: 1.3.14

      - name: Install dependencies
        run: |
          bun install --frozen-lockfile
          cd gui
          bun install --frozen-lockfile

      # Each job gets its own workspace, so `gates` building the GUI does nothing
      # for this one. Tests that fetch the served dashboard read their session
      # bootstrap out of gui/dist/index.html, and with no build the server has no
      # index to serve. The old three-platform job satisfied this by accident,
      # because the suite and the GUI build shared a job.
      - name: Build GUI
        run: |
          cd gui
          bun run build

      - name: Test
        run: bun test --isolate tests --shard=${{ matrix.shard }}/4
```

Note `timeout-minutes: 15` rather than 30. A shard that needs longer than a
quarter hour to run a quarter of the suite is wedged, not slow. The 30-minute
ceiling existed for the Windows leg; carrying it onto a Linux shard would
re-import a limit that was always about the platform being removed.

**The GUI install stays.** An earlier draft dropped it, reasoning that the 25
test files touching `gui/` read source rather than built artifacts. That was an
assumption written from a grep of import paths, and it is false. Several of
those files import JSX-bearing components:

```
$ bun test tests/provider-workspace-rail.test.ts
error: Cannot find module 'react/jsx-dev-runtime' from
  gui/src/components/provider-workspace/ProviderRail.tsx
0 pass, 1 fail
```

`gui/src/components/provider-workspace/ProviderRail.tsx:52` returns JSX, React
is declared only in `gui/package.json`, and a fresh checkout has no
`gui/node_modules`. Without the install, shards containing these files fail and
shards without them pass — an intermittent, shard-count-dependent failure,
which is the worst shape this could have taken.

The cost is real: `cd gui && bun install` now runs in each of the four shards.
It is accepted rather than optimized away, because the alternative (splitting
GUI-importing tests into their own suite) is a test-layout change and belongs
in its own unit, not smuggled into a CI restructure.

### 1b. New `gates` job — the once-only checks

```yaml
  # Everything that is not the suite: type safety, privacy, lint, build, smoke.
  # One runner, once per push. Splitting these across shards would repeat a
  # fixed ~2 minutes four times to save nothing.
  gates:
    name: gates
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7

      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: 1.3.14

      - name: Install dependencies
        run: |
          bun install --frozen-lockfile
          cd gui
          bun install --frozen-lockfile

      - name: Typecheck
        run: bun x tsc --noEmit

      - name: GUI tests
        run: cd gui && bun test tests

      - name: Privacy scan
        run: bun run privacy:scan

      - name: Check release helper syntax
        run: bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check

      - name: GUI lint
        run: |
          cd gui
          bun run lint

      - name: GUI build
        run: |
          cd gui
          bun run build

      - name: CLI help smoke
        run: bun run src/cli/index.ts help
```

### 1c. New `ci` aggregate gate

```yaml
  # The one check name that means "CI passed".
  #
  # Shard names change whenever the shard count changes, and platform jobs come
  # and go by trigger. Neither is a stable thing to require in branch
  # protection. This job is: it depends on everything and asserts each result.
  #
  # `if: always()` is required — without it, a skipped or failed dependency
  # skips this job too, and a skipped job reports success. The gate would then
  # go green precisely when something went wrong, which is worse than having no
  # gate at all.
  #
  # `skipped` counts as a pass on purpose: that is how an area-filtered job
  # reports when its paths were untouched (see phase 2). `failure` and
  # `cancelled` do not.
  ci:
    name: ci
    if: always()
    # EVERY producer, including the ones that only feed other jobs. `needs` holds
    # direct dependencies only — it "doesn't include implicitly dependent jobs" —
    # so a failing `changes` or `select-windows-runner` would otherwise reach this
    # gate as nothing at all, while the jobs downstream of it report `skipped`
    # and the gate calls that a pass.
    #
    # PHASE-ORDERED: this list names only jobs that exist *at this phase*.
    # `needs:` pointing at an undefined job is a hard workflow error —
    # actionlint: `job "ci" needs job "does-not-exist" which does not exist in
    # this workflow`. Phase 2 adds `changes` to this list when it creates that
    # job. The derived pin below is what forces it.
    needs: [select-windows-runner, test, gates, platform-macos, platform-windows, npm-global-smoke]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Assert every needed job succeeded or was skipped
        shell: bash
        env:
          RESULTS: ${{ toJSON(needs) }}
        run: |
          set -euo pipefail
          echo "$RESULTS" | jq .
          # Allowlist, not denylist: anything that is not a known-good result
          # fails the gate. A denylist passes silently on any result GitHub adds
          # later, and "the gate quietly stopped catching a new failure mode" is
          # not a thing that should be possible here.
          #
          # `skipped` passes because that is how an area-filtered job (phase 2)
          # and a trigger-scoped platform job (this phase) report when they are
          # deliberately not run.
          bad=$(echo "$RESULTS" | jq -r '
            to_entries
            | map(select(.value.result != "success" and .value.result != "skipped"))
            | .[] | "\(.key)=\(.value.result)"')
          if [ -n "$bad" ]; then
            echo "::error::needed job(s) did not pass: $bad"
            exit 1
          fi
```

Reading results out of `toJSON(needs)` rather than naming each job means adding
a job to `needs:` automatically extends the assertion. The failure mode of the
name-by-name form is silent: someone adds a job, forgets the corresponding
`test "${{ needs.x.result }}" = success` line, and the gate stops covering it
while still looking thorough.

An earlier draft grepped the JSON text for `'"result": "failure"'`. GitHub does
document `toJSON` as returning "a pretty-print JSON representation", so that
grep would in fact have matched — but a gate whose ability to fail depends on
the whitespace of a pretty-printer is correct by coincidence. `jq` parses the
structure instead, and `jq` is present on `ubuntu-latest`.

## File: `tests/ci-workflows.test.ts` — MODIFY

The existing pins describe the old shape and must move deliberately.

### Pin 1 — per-job timeouts and their exact count

BEFORE:

```ts
    expect(ci.jobs?.["select-windows-runner"]?.["timeout-minutes"]).toBe(2);
    expect(ci.jobs?.test?.["timeout-minutes"]).toBe(30);
    expect(ci.jobs?.["npm-global-smoke"]?.["timeout-minutes"]).toBe(8);
    // Every job must stay bounded — an unbounded job can hang a queue for hours.
    expect(count(workflow, "timeout-minutes:")).toBe(3);
```

AFTER:

```ts
    expect(ci.jobs?.test?.["timeout-minutes"]).toBe(15);
    expect(ci.jobs?.gates?.["timeout-minutes"]).toBe(15);
    expect(ci.jobs?.ci?.["timeout-minutes"]).toBe(5);
    expect(ci.jobs?.["npm-global-smoke"]?.["timeout-minutes"]).toBe(8);
    // Every job must stay bounded — an unbounded job can hang a queue for hours.
    // Asserted structurally rather than by counting the string: a count passes
    // if a new job is added and an old one loses its bound in the same edit.
    for (const [name, job] of Object.entries(ci.jobs ?? {})) {
      expect(`${name}:${typeof job?.["timeout-minutes"]}`).toBe(`${name}:number`);
    }
```

The `count(...) === 3` assertion is *strengthened*, not dropped. Counting
occurrences of a string only proves three bounds exist somewhere; iterating the
parsed jobs proves every job has one, which is what the comment above it always
claimed. The `${name}:` prefix makes a failure name the offending job instead
of reporting `undefined !== number`.

### Pin 2 — the test command

BEFORE:

```ts
    expect(workflow).toContain("bun test --isolate tests");
```

AFTER: unchanged. `bun test --isolate tests --shard=${{ matrix.shard }}/4`
still contains that substring, so the pin holds as written and keeps meaning
what it meant: the suite runs isolated.

Add alongside it:

```ts
    // Sharding is only safe while the shards tile the suite exactly. If the
    // matrix and the divisor drift apart, some files stop running and CI stays
    // green — the worst available failure. Pin them to each other.
    const shards = (ci.jobs?.test as { strategy?: { matrix?: { shard?: number[] } } })
      ?.strategy?.matrix?.shard ?? [];
    expect(shards).toEqual([1, 2, 3, 4]);
    expect(workflow).toContain(`--shard=\${{ matrix.shard }}/${shards.length}`);
```

That is the pin this phase actually needs. A matrix of `[1, 2, 3]` against
`/4` runs three quarters of the suite and reports success.

### Pin 3 — the gate cannot be neutered

New:

```ts
    // The aggregate gate is the check a human trusts. Three ways to break it
    // silently: drop `if: always()` so it skips (and a skipped job reports
    // success), shrink `needs:` so it stops covering a job, or let `needs`
    // drift behind the job list so a new job is never gated. Pin all three.
    const gate = ci.jobs?.ci as { if?: unknown; needs?: string[] } | undefined;
    expect(gate?.if).toBe("always()");
    const gated = [...(gate?.needs ?? [])].sort();
    const everyOtherJob = Object.keys(ci.jobs ?? {}).filter(n => n !== "ci").sort();
    expect(gated).toEqual(everyOtherJob);
```

The derived comparison also solves the phase-ordering hazard. Each phase adds
jobs *and* must extend `needs:` in the same commit, because the assertion is
recomputed from whatever jobs the workflow currently defines — a phase that
adds a job without gating it fails the suite immediately, and a phase that
gates a job it has not defined fails actionlint. The two checks close from
opposite directions.

`needs:` after each phase, stated so no phase has to infer it:

| after | `ci.needs` |
|---|---|
| phase 1 (this doc + `011`) | `select-windows-runner, test, gates, platform-macos, platform-windows, npm-global-smoke` |
| phase 2 (`030`) | the above **plus `changes`** |

`Bun.YAML.parse` leaves `if: always()` as the string `"always()"`, verified:

```
$ bun -e 'console.log(JSON.stringify(Bun.YAML.parse("jobs:\n  ci:\n    if: always()\n")))'
{"jobs":{"ci":{"if":"always()"}}}
```

The `everyOtherJob` comparison is the assertion that matters most in this file.
A hardcoded list rots the moment someone adds a job; deriving it from the
workflow means the suite fails the instant a job exists that the gate does not
cover.

## Verification for this phase

1. `actionlint .github/workflows/ci.yml` exits 0.
2. `bun test tests/ci-workflows.test.ts` passes.
3. Shard tiling re-proven after the edit: per-shard file counts sum to the
   discovered total.
4. One shard executed locally end-to-end — specifically a shard containing the
   JSX-importing GUI tests, since those are what an install mistake breaks.
5. `actionlint` run against the **assembled** workflow, not against fragments.
   Round 3 of the audit caught a duplicate `steps:` key that fragment-level
   checking could not see.

## Out of scope here

Area/path scoping. This phase adds no conditions based on *changed files* and
creates no `changes` job. The only conditions it introduces are the trigger
scoping on `platform-windows` and the `always()` on the gate — both about which
event is running, not about which files moved. That keeps this commit's blast
radius to "the same work, rearranged across jobs", so a bisect against a broken
dev lane has one variable rather than two.
