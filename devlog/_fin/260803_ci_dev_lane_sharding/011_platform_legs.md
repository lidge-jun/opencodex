# Phase 1b — Windows off the PR lane, macOS as the platform control

Companion to `010_linux_shard_matrix.md`. **Same commit, same phase** — the two
documents describe one workflow rewrite, split by topic for readability rather
than by delivery. `010` covers the shards, the `gates` job, and the aggregate
check; this one covers the two platform jobs that replace the Windows and macOS
legs of the old matrix.

> **Amended after audit rounds 1 and 2** (`002_audit_synthesis.md`).
> Round 1: Option A is the only option (a job `if:` cannot read `matrix`, proven
> with actionlint), and the Windows condition is dispatch-or-main/preview rather
> than not-pull-request.
> Round 2: the Windows steps are actually enumerated here rather than deferred
> to "same shape as macOS", and the `ci.needs` update is stated as this phase's
> work rather than assumed done elsewhere.

## The decision, stated plainly

Windows stops running on `pull_request` and on `push` to `dev`. It keeps
running on `push` to `main` and `preview`, and on `workflow_dispatch`.

macOS **stays as it is**: a full unsharded suite run on the PR lane.

That second sentence is a deliberate reversal of an earlier draft of this unit,
which had macOS reduced to a build-and-smoke leg. Two reasons it is wrong to
reduce it:

1. **Sharding needs a control.** Four shards each running a quarter of the
   suite share an assumption: that no test depends on another test's file
   having run in the same process pool. A single unsharded full-suite run is
   the thing that would notice if that assumption broke. Removing Windows and
   sharding Linux in the same unit leaves *no* unsharded full run — unless
   macOS is it.
2. **macOS is the maintainer's own platform.** Local development happens there,
   so a macOS regression is caught fastest and matters most immediately.

macOS is also the cheapest of the three to keep in wall-clock terms: 5m 23s,
*faster* than the Linux leg it sits beside. There was never a latency argument
for touching it. The only argument was the 5-job macOS concurrency cap, and one
job per push does not threaten that.

So the shape is: Linux answers fast and in parallel, macOS answers whole,
Windows answers before anything ships.

## Why Windows can leave the PR lane specifically

Not because Windows matters less — because of *when* its failures are
actionable. Windows-specific defects in this repository cluster in service
installation, path handling, and process lifetime: `service-lifecycle.yml`
already covers the first, and the rest surface at install/run time, which is
what promotion and release exercise. Meanwhile the Windows leg costs 16m 23s of
every contributor's feedback loop on changes that are, in the overwhelming
majority, platform-neutral TypeScript.

The trade is explicit: a Windows-only regression can now land on `dev` and be
caught at promotion rather than at PR. That is a real regression in coverage
timing, and it is the price. What makes it acceptable is that `dev` is not
published — `main` and `preview` are, and both still gate on Windows before
they move.

## File: `.github/workflows/ci.yml` — MODIFY

### 1d. Platform jobs, trigger-scoped

The `select-windows-runner` job and its comment block stay exactly as they are.
That comment explains that runner routing is a cost control and *not* a
security boundary, that a hostile PR can rewrite the routing, and that the
fork-approval policy is the only real protection. None of that reasoning
changes; it is copied forward verbatim.

The conditional-matrix idea is dead on arrival. A job-level `if:` cannot read
the `matrix` context — verified rather than assumed:

```
$ actionlint  # on a minimal repro with `if: ${{ matrix.name != 'windows' }}`
context "matrix" is not allowed here. available contexts are
  "github", "inputs", "needs", "vars".
```

GitHub's context-availability table confirms it: `jobs.<job_id>.if` may use
`github`, `needs`, `vars`, and `inputs`. So the platform legs become two
ordinary jobs.

```yaml
  # macOS runs on every PR. The Linux shards each cover a quarter of the suite,
  # so this is the only place the whole suite runs in one process pool. If shard
  # independence ever breaks — a test that passes only because a sibling file ran
  # first — this leg is what notices.
  platform-macos:
    name: macos
    runs-on: macos-latest
    timeout-minutes: 30
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
      # The whole suite, unsharded and in one pool. Deliberately NOT the gates:
      # typecheck, privacy scan, and lint are platform-independent and already
      # run once in `gates`. Repeating them here is what made the old three-OS
      # matrix pay for everything three times.
      #
      # The GUI *build* is the exception, and it is not optional: each job has its
      # own workspace, so `gates` building the GUI does nothing for this one, and
      # the root suite serves gui/dist and reads it back.
      - name: Build GUI
        run: |
          cd gui
          bun run build

      - name: Test
        run: bun test --isolate tests
      - name: CLI help smoke
        run: bun run src/cli/index.ts help

  # Windows runs when something is about to ship — promotion to main/preview, or
  # an explicit dispatch — not on every pull request. It is a 16-minute leg
  # against a 6-minute Linux critical path, and it was deciding when every PR
  # turned green. The coverage is not dropped, only moved to the boundary where
  # a maintainer acts on it: release.yml refuses to publish a commit without a
  # successful run of this workflow.
  platform-windows:
    name: windows
    needs: select-windows-runner
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'push' &&
       (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/preview'))
    runs-on: ${{ fromJSON(needs.select-windows-runner.outputs.runner) }}
    timeout-minutes: 30
    steps:
      - name: Show selected runner
        shell: bash
        run: echo "windows leg on ${{ needs.select-windows-runner.outputs.label }}"

      # A self-hosted runner keeps its working directory between jobs. Without an
      # explicit wipe, a file deleted in the commit under test survives on disk
      # and the suite passes against a tree that no longer exists in git.
      # `--ephemeral` registration de-registers the runner after each job but does
      # not clean the workspace, so this step is what makes the checkout honest.
      - name: Clean workspace (self-hosted only)
        if: runner.environment == 'self-hosted'
        shell: bash
        run: git clean -xffd . || true

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

      - name: Build GUI
        run: |
          cd gui
          bun run build

      - name: Test
        run: bun test --isolate tests

      - name: CLI help smoke
        run: bun run src/cli/index.ts help
```

Both the runner diagnostic and the self-hosted workspace wipe are carried over
verbatim from the current `test` job. They exist for reasons written in their
own comments, and neither has anything to do with this restructure — losing
them here would be exactly the silent deletion this unit's audit rounds keep
catching.

The condition is spelled out positively — dispatch, or a push to `main` or
`preview` — rather than as `!= 'pull_request'`. The negative form is the bug the
audit caught: it also runs Windows on every `push` to `dev`, which is most of
the traffic this unit exists to speed up, so the change would have looked
correct and achieved close to nothing.

The `select-windows-runner` job and its comment block are untouched. That
comment explains that runner routing is a cost control and *not* a security
boundary, that a hostile PR can rewrite the routing, and that the fork-approval
policy is the only real protection. All of it carries forward verbatim.

### `needs:` for the gate

Both jobs created here go into the gate's `needs:` in this same commit:

```yaml
    needs: [select-windows-runner, test, gates, platform-macos, platform-windows, npm-global-smoke]
```

That is not optional bookkeeping. The suite pin derives the expected `needs`
list from the workflow's own job keys, so creating a job without gating it
fails the tests immediately.

`platform-windows` is skipped on pull requests, and a skipped job reports
success — which is exactly why the gate's allowlist admits `skipped`. Without
that, every PR would fail its gate on the deliberately-absent Windows leg.

### 1e. `npm-global-smoke` keeps all three OSes

Untouched. Its own comment already explains the reasoning — it is an 8-minute
job that deliberately avoids the self-hosted box, and its Windows leg is 1m 53s.
There is nothing to win by moving it and real coverage to lose: it is the only
check that `npm install -g` works on Windows without a separate Bun.

## File: `tests/ci-workflows.test.ts` — MODIFY

The shard document replaced the timeout pins; this document extends them for the
adds the assertion that keeps this decision honest:

```ts
    expect(ci.jobs?.["select-windows-runner"]?.["timeout-minutes"]).toBe(2);
    expect(ci.jobs?.["platform-macos"]?.["timeout-minutes"]).toBe(30);
    expect(ci.jobs?.["platform-windows"]?.["timeout-minutes"]).toBe(30);
```

```ts
    // Windows leaving the PR lane is a trade, not a deletion: it still runs
    // before anything is published. Assert the positive condition, not the
    // absence of `pull_request` — `!= 'pull_request'` also matches every push to
    // dev, which would quietly restore the 16-minute leg to the busiest lane and
    // still pass a loosely-worded test.
    const windowsIf = String((ci.jobs?.["platform-windows"] as { if?: string })?.if ?? "");
    expect(windowsIf).toContain("github.event_name == 'workflow_dispatch'");
    expect(windowsIf).toContain("github.ref == 'refs/heads/main'");
    expect(windowsIf).toContain("github.ref == 'refs/heads/preview'");
    expect(windowsIf).not.toContain("refs/heads/dev");

    // macOS is the unsharded control for the sharded Linux lane. If it stops
    // running the whole suite, sharding loses the thing that would catch a
    // cross-file dependency between shards.
    const macosSteps = (ci.jobs?.["platform-macos"] as { steps?: { run?: string }[] })?.steps ?? [];
    expect(macosSteps.some(s => s.run?.includes("bun test --isolate tests"))).toBe(true);
    expect(macosSteps.some(s => s.run?.includes("--shard"))).toBe(false);
    // Unconditional: a control that only sometimes runs is not a control.
    expect(ci.jobs?.["platform-macos"]).not.toHaveProperty("if");
```

```ts
    // Windows must run the same full suite, and must keep the self-hosted
    // workspace wipe. Without the wipe a deleted file survives on the runner's
    // disk and the suite passes against a tree that no longer exists in git —
    // the failure that step was added to prevent.
    const winSteps = (ci.jobs?.["platform-windows"] as { steps?: { if?: string; run?: string }[] })?.steps ?? [];
    expect(winSteps.some(s => s.run?.includes("bun test --isolate tests"))).toBe(true);
    expect(winSteps.some(s => s.run?.includes("--shard"))).toBe(false);
    expect(winSteps.some(s => s.if === "runner.environment == 'self-hosted'"
      && s.run?.includes("git clean -xffd"))).toBe(true);
```

The last two assertions are the ones worth having: macOS must not be sharded
and must not be conditional, which is the entire reason it was kept.

## Verification for this phase

1. `actionlint` exits 0.
2. `bun test tests/ci-workflows.test.ts` passes.
3. Manual matrix expansion recorded for both events: what jobs a
   `pull_request` produces, and what a `push` to `main` produces. This is the
   claim that cannot be checked locally by running anything, so it is checked
   by reading and written down.
4. Live confirmation in phase 3 (`040`): the PR run shows no Windows test leg, and a
   `workflow_dispatch` run shows one.

## Risk register

| risk | mitigation |
|---|---|
| Windows-only regression lands on `dev` | Caught at promotion to `main`/`preview`; `dev` is not published |
| Someone requires the old `windows` check name in future branch protection | The stable `ci` gate is the name to require; `dev` has no protection configured today |
| Skipped Windows job read as a pass by a human skimming checks | The `ci` gate is one line and covers it; the PR description states the trade |
