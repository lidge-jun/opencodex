# Phase 2 — affected-path scoping, per job

Consumes phase 1 (`010` + `011`), which made the lane parallel and moved the
slowest platform off it. This phase stops jobs running at all when nothing they
cover changed. It is the second and last workflow commit.

> **Amended after audit rounds 1 and 2** (`002_audit_synthesis.md`).
> Round 1: the `changes` job gains `pull-requests: read` (without it the filter
> cannot read a PR's files at all), and the packaging filter covers `src/**` so
> an ordinary source PR keeps a Windows signal.
> Round 2: the workflow-level path list is widened in step with the packaging
> filter, the `ci.needs` update is stated as this phase's work, and the filter
> pin compares the whole pattern list instead of four samples.

## The rule that shapes everything here

Workflow-level `paths:` and job-level `if:` behave in opposite ways when a
required check is involved:

- Workflow skipped by `paths:` → its checks stay **Pending** forever, and a PR
  requiring them can never merge.
- Job skipped by `if:` → reports **Success**.

So: the workflow-level `paths:` filter stays a *coarse* relevance filter and is
never used to scope a required check. All new scoping is job-level.

That list is not frozen, though — it grows from 14 entries to 17 later in this
phase, because three packaging inputs were missing from it. What matters is
that it is edited deliberately and pinned element-by-element in the suite (its
pins exist because an audit round deleted entries one at a time and nothing
went red), not that it never changes.

## What is worth scoping, and what is not

Scoping has a cost: a filter job runs first, every downstream job waits on it,
and the whole thing is one more place to be wrong. It pays only where the job
being skipped is expensive and the area is genuinely separable.

| job | scope it? | reasoning |
|---|---|---|
| `test` shards | **no** | Any `src/**` or `tests/**` change can affect any test. The correlation between changed path and affected test is not something a glob knows. |
| `gates` | **no** | Typecheck and privacy scan are whole-tree properties. ~2 minutes. |
| GUI lint / GUI build | **yes** | Only `gui/**` can break them, and they are a real chunk of the `gates` job. |
| `npm-global-smoke` | **yes** | 3 jobs of packaging proof, only meaningful when packaging inputs move: `package.json`, `bin/**`, `.npmignore`, `gui/**`, `scripts/prepare-package.ts`. |
| `platform-macos` | **no** | It is the unsharded control (phase 1). A control that only sometimes runs is not a control. |

That table is the whole design. Two targets, both expensive, both cleanly
separable. Scoping the shards would be the obvious next idea and it is the one
to refuse: `bun test --changed` exists, but "which tests does this diff affect"
is exactly the question whose wrong answer is a green CI over untested code.

### `npm-global-smoke` and the Windows signal

Widening the packaging filter is an audit correction with a specific failure
behind it. The first draft filtered on `package.json`, `bun.lock`, `bin/**`,
`.npmignore`, `gui/**`, and `scripts/prepare-package.ts` — omitting `src/**`.

But `package.json` ships `src` in its `files` array, and `bin/ocx.mjs` executes
that shipped source. So a PR touching only `src/router.ts` would have had:

- no Windows suite (phase 1 moved it off PRs),
- no Windows service-lifecycle run (that workflow watches four specific source
  paths, not `src/**`),
- and no Windows packaged-CLI smoke (filtered out by the omission).

Zero Windows verification for the single most common kind of change in this
repository. The 1m 53s Windows smoke is the cheap signal that keeps that from
being true, and it only fires if `src/**` is in the filter.

## File: `.github/workflows/ci.yml` — MODIFY

### 2a. New `changes` job

```yaml
  # Which areas this push actually touches.
  #
  # Deliberately a job-level filter, not a workflow-level `paths:` one: a
  # workflow skipped by path filtering leaves its checks Pending forever, which
  # would block a PR that requires them. A skipped *job* reports success, which
  # is what makes this safe.
  changes:
    name: changes
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      gui: ${{ steps.filter.outputs.gui }}
      packaging: ${{ steps.filter.outputs.packaging }}
    steps:
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7

      - name: Detect changed areas
        id: filter
        uses: dorny/paths-filter@de90cc6fb38fc0963ad72b210f1f284cd68cea36 # v3.0.2
        with:
          # WITHOUT THIS the action compares against the repository's DEFAULT
          # branch, which is `main`. A push to `dev` would then be diffed against
          # `main`, so every area touched since the last promotion keeps reading
          # as "changed" — the GUI and packaging jobs would run on nearly every
          # dev push until main caught up, and the per-push saving this phase
          # exists to produce would silently not happen while CI stayed green.
          #
          # On `pull_request` the action ignores this and uses the PR's own file
          # list. On a branch push it means "compare against the previous commit
          # on this same branch", which is the intent.
          base: ${{ github.ref }}
          filters: |
            gui:
              - 'gui/**'
            packaging:
              - 'package.json'
              - 'bun.lock'
              - 'bin/**'
              - '.npmignore'
              - 'gui/**'
              - 'scripts/prepare-package.ts'
```

corrected to cover everything that reaches the published tarball:

```yaml
            # Everything that ends up inside `npm pack`, or that decides what
            # does. `src/**` belongs here because package.json ships `src` and
            # bin/ocx.mjs executes it — without this entry an ordinary source PR
            # gets no Windows verification at all once phase 1 moves the Windows
            # suite off pull requests.
            packaging:
              - 'package.json'
              - 'bun.lock'
              - 'src/**'
              - 'bin/**'
              - 'gui/**'
              - 'assets/**'
              - '.npmignore'
              - 'README.md'
              - 'LICENSE'
              - 'scripts/prepare-package.ts'
```

### The filter cannot see what the workflow never runs for

Three of those entries — `assets/**`, `README.md`, `LICENSE` — are real tarball
inputs but do **not** appear in the workflow's own `on.*.paths` list. A PR that
changes only `README.md` never triggers this workflow, so `changes` never runs
and the packaging filter never gets the chance to fire.

A per-job filter can only ever narrow what the workflow-level filter admits.
Widening the inner list past the outer one buys nothing and reads as coverage
that does not exist.

So the outer list grows from 14 entries to 17, in the same commit:

```yaml
    paths:
      # ... existing 14 entries ...
      - "assets/**"
      - "README.md"
      - "LICENSE"
```

applied identically to `push` and `pull_request` — the suite asserts the two
lists are equal, and its comment explains why: otherwise "a change lands on
`dev` having been checked on one trigger and not the other".

`tests/ci-workflows.test.ts`'s pinned `ciPaths` array grows by the same three
entries. That array is pinned element-by-element on purpose (an audit round
once deleted entries one at a time with the suite staying green), so extending
it is a deliberate edit, which is the intent.

**Alternative considered and rejected:** drop the three entries from the
packaging filter instead, leaving the outer list alone. That is less code and
it is wrong — a README change genuinely does alter the published tarball, and
`npm-global-smoke` is the only check that packs it.

This deliberately keeps `npm-global-smoke` running for most PRs. The saving is
narrower than the first draft implied — it now skips only for changes confined
to tests, workflows, or docs — and that is the honest scope. Claiming the wider
saving would have meant deleting a platform signal without saying so.

The `changes` job also needs a permission the workflow does not currently
grant:

```yaml
  changes:
    name: changes
    runs-on: ubuntu-latest
    timeout-minutes: 5
    # The workflow grants only `contents: read`, and specifying any permission
    # sets every unspecified one to `none`. paths-filter reads the PR's file list
    # through the API on `pull_request`, so without this it fails outright — and
    # a failed filter means empty outputs, which reads as "nothing changed".
    permissions:
      contents: read
      pull-requests: read
```

The action must be pinned to a full commit SHA: `tests/ci-workflows.test.ts`
asserts `expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/)`,
and a mutable third-party action ref is a supply-chain hole `AGENTS.md` calls a
release blocker. The SHA above is resolved and re-verified during build rather
than trusted from this document.

**Alternative considered:** computing the diff with `git diff --name-only`
against the merge base in a plain shell step, avoiding the third-party action
entirely. Cheaper in trust, more expensive in correctness — the merge-base
calculation differs between `push` and `pull_request`, needs `fetch-depth: 0`,
and gets subtly wrong on force-pushes. If review objects to the dependency,
this is the fallback and the tradeoff is a known one.

### 2b. Conditioning the scoped work

GUI steps inside `gates` become conditional rather than the whole job:

```yaml
      - name: GUI lint
        if: needs.changes.outputs.gui == 'true'
        run: |
          cd gui
          bun run lint

      - name: GUI build
        if: needs.changes.outputs.gui == 'true'
        run: |
          cd gui
          bun run build
```

`gates` gains `needs: changes`. Step-level rather than job-level because
`gates` also carries typecheck and the privacy scan, which always run.

`npm-global-smoke` is skipped as a whole job:

```yaml
  npm-global-smoke:
    name: npm-global ${{ matrix.os }}
    needs: changes
    if: needs.changes.outputs.packaging == 'true'
```

### 2c. Gate interaction

The gate's *logic* needs no change: it already admits `skipped` and rejects
everything that is not `success` or `skipped`, which is precisely the behavior
this phase depends on. Worth restating because it is the load-bearing detail —
had the gate been written as `test "${{ needs.npm-global-smoke.result }}" =
success`, this phase would fail every PR that does not touch packaging.

The gate's `needs:` **does** change, in this commit, because this phase creates
a job:

```yaml
    needs: [changes, select-windows-runner, test, gates, platform-macos, platform-windows, npm-global-smoke]
```

`changes` must be gated directly. It is an upstream producer, so if it fails,
its dependents report `skipped` — which the gate reads as a deliberate skip. A
failed filter would otherwise pass the gate while silently disabling two jobs.

## File: `tests/ci-workflows.test.ts` — MODIFY

The GUI-gate pins from the original suite must survive in a form that still
means something. The current assertions are substring checks:

```ts
    expect(workflow).toContain("- name: GUI lint");
    expect(workflow).toContain("bun run lint");
    expect(workflow).toContain("- name: GUI build");
    expect(workflow).toContain("bun run build");
```

These still pass after adding `if:` lines — which is the problem. Their comment
says they exist because "the GUI build gate was silently dropped once" (PR #97).
A gate that is present but permanently false is dropped in every sense that
matters. Strengthen:

```ts
    // PR #97 dropped the GUI build gate silently once, hence these pins. After
    // area-scoping they must assert more than presence: a step conditioned on a
    // filter that never fires is a dropped gate wearing the step's name. Pin
    // the condition to the filter output that this phase defines.
    const gateSteps = (ci.jobs?.gates as { steps?: { name?: string; if?: string; run?: string }[] })?.steps ?? [];
    for (const stepName of ["GUI lint", "GUI build"]) {
      const step = gateSteps.find(s => s.name === stepName);
      expect(`${stepName}:${step === undefined}`).toBe(`${stepName}:false`);
      expect(String(step?.if)).toBe("needs.changes.outputs.gui == 'true'");
    }
```

And a pin that the filter itself covers what it claims:

```ts
    // A filter with an empty or narrowed pattern list skips the job it guards
    // on every run, and reports success while doing it.
    const filters = String(
      (ci.jobs?.changes as { steps?: { with?: { filters?: string } }[] })
        ?.steps?.find(s => s.with?.filters)?.with?.filters ?? "",
    );
    expect(filters).toContain("'gui/**'");
    expect(filters).toContain("'package.json'");
    expect(filters).toContain("'bin/**'");
```

Sampling four patterns is not enough: deleting `bun.lock`, `.npmignore`,
`assets/**`, `README.md`, `LICENSE`, or `scripts/prepare-package.ts` would keep
that green while quietly shrinking what gets packaging verification. Compare
the whole list:

```ts
    // Whole-list comparison, not samples. Every entry here is an input to the
    // published tarball; dropping one silently stops packaging verification for
    // that surface, which is the failure mode this pin exists to catch.
    const packaging = filters
      .split(/\n\s*packaging:\s*\n/)[1]?.split(/\n\s*\w+:\s*\n/)[0] ?? "";
    const patterns = [...packaging.matchAll(/-\s*'([^']+)'/g)].map(m => m[1]).sort();
    expect(patterns).toEqual([
      ".npmignore",
      "LICENSE",
      "README.md",
      "assets/**",
      "bin/**",
      "bun.lock",
      "gui/**",
      "package.json",
      "scripts/prepare-package.ts",
      "src/**",
    ]);
```

```ts
    // `src/**` in the packaging filter is load-bearing for platform coverage,
    // not a convenience: it is what keeps a source-only PR running the Windows
    // packaged-CLI smoke after the Windows suite moved to promotion.
    expect(filters).toContain("'src/**'");

    // paths-filter cannot read a PR's file list without this, and a filter that
    // errors produces empty outputs — which every `== 'true'` condition reads as
    // "skip". The jobs would silently stop running.
    expect((ci.jobs?.changes as { permissions?: Record<string, string> })?.permissions)
      .toEqual({ contents: "read", "pull-requests": "read" });
```

```ts
    // `base` is not cosmetic. Unset, paths-filter diffs a `dev` push against the
    // repository default branch (`main`), so everything changed since the last
    // promotion still reads as changed and the scoped jobs run anyway — the
    // filter would look correct, stay green, and save nothing. Pinning it to the
    // pushed ref is what makes the scoping per-push rather than per-release.
    const filterStep = (ci.jobs?.changes as { steps?: { with?: Record<string, string> }[] })
      ?.steps?.find(s => s.with?.filters);
    expect(filterStep?.with?.base).toBe("${{ github.ref }}");
```

## Verification for this phase

1. `actionlint` exits 0.
2. `bun test tests/ci-workflows.test.ts` passes.
3. The action SHA resolves to the claimed version tag, checked against the
   upstream repository rather than copied from this doc.
4. Live evidence in phase 3 (`040`): a commit touching only devlog files shows
   `npm-global-smoke` skipped and the `ci` gate green — the exact combination
   that would break under a naive gate.

## What this phase deliberately does not do

No `bun test --changed`. No per-shard test selection. No skipping the suite on
a docs-only diff. The suite is the thing CI exists to run; the savings here
come from not repeating *packaging and GUI* work that provably cannot be
affected, and stop there.
