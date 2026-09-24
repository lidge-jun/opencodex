# 040 — Narrow checks for the setup action and the remote-workspace helper (wp4)

## Change map

| Path | Action |
| --- | --- |
| `.github/workflows/ci.yml` | MODIFY — two filters, a validated output step, two jobs, aggregate wiring |
| `tests/ci-workflows/ci-scope-gaps.test.ts` | NEW |
| layout files | MODIFY — register the test |

## Filters (changes job)

```diff
+            # The composite action every Bun job runs. The ci filter above omits .github/actions/**
+            # on purpose, so an edit that changes only the action gets this narrow check instead of
+            # the full matrix.
+            setup_action:
+              - '.github/actions/**'
+              - '.github/workflows/ci.yml'
+            # The Rust helper crate. Nothing else builds it, and its sandbox is real only on macOS
+            # and Windows.
+            remote_helper:
+              - 'native/remote-workspace-helper/**'
+              - '.github/workflows/ci.yml'
```

Both stay pull-request scope, like `docs` and `structure`: the push trigger's `paths:` is pinned
to equal the `ci` filter, and neither path is added to `ci` (that would start the full suite).

New step after "Assert the native and matrix outputs are usable":

```yaml
      - name: Assert the narrow scope outputs are usable
        id: narrow
        shell: bash
        env:
          SETUP_ACTION: ${{ steps.filter.outputs.setup_action }}
          REMOTE_HELPER: ${{ steps.filter.outputs.remote_helper }}
        run: |
          set -euo pipefail
          for pair in "setup_action=$SETUP_ACTION" "remote_helper=$REMOTE_HELPER"; do
            case "${pair#*=}" in
              true|false) printf '%s\n' "$pair" >> "$GITHUB_OUTPUT" ;;
              *) printf '::error::changes.outputs.%s was %q, expected true or false\n' "${pair%%=*}" "${pair#*=}"; exit 1 ;;
            esac
          done
```

Outputs: `setup_action: ${{ steps.narrow.outputs.setup_action }}`,
`remote_helper: ${{ steps.narrow.outputs.remote_helper }}`.

## Jobs

```yaml
  setup-action:
    name: setup action ${{ matrix.os }}
    needs: changes
    if: needs.changes.outputs.setup_action == 'true'
    runs-on: ${{ matrix.os }}
    timeout-minutes: 5
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    steps:
      - Checkout (persist-credentials: false)
      - name: Setup project Bun
        id: bun
        uses: ./.github/actions/setup-project-bun
      - name: Require the runtime package.json declares
        shell: bash
        env:
          RESOLVED: ${{ steps.bun.outputs.version }}
        run: declared (node -p package.json dependencies.bun) == RESOLVED == bun --version, else ::error and exit 1

  remote-helper:
    name: remote helper ${{ matrix.os }}
    needs: changes
    if: needs.changes.outputs.remote_helper == 'true'
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    strategy: { fail-fast: false, matrix: { os: [ubuntu-latest, macos-latest, windows-latest] } }
    steps:
      - Checkout (persist-credentials: false)
      - dtolnay/rust-toolchain@02cb101ec7c40f2c49e1d9714d64511d8e1b74de # master (stable, rustfmt, clippy)
      - cargo fmt --check                       (Linux leg)
      - cargo clippy --locked --all-targets -- -D warnings
      - cargo test --locked                     (live confinement tests compile only on macOS/Windows)
```

Each leg is one small job, not a suite: the action check is about a minute per runner and the
helper check compiles a four-dependency crate. Neither job runs for an ordinary pull request, because
neither filter matches ordinary source paths. Both run on this lane's own pull request because it
edits `ci.yml`, which is how the jobs get proven.

## Aggregate gate

`needs` gains `setup-action, remote-helper`; env gains `CHANGES_SETUP_ACTION` and
`CHANGES_REMOTE_HELPER`; two derived states (`requested` iff the output is `true`); `expected_for`
gains `setup-action) echo "$setup_action" ;;` and `remote-helper) echo "$remote_helper" ;;`;
`GATED_JOBS` gains a new line `GATED_JOBS="$GATED_JOBS setup-action remote-helper"` (the existing
lines are pinned verbatim by `ci-structure-gate.test.ts`).

## Tests (`tests/ci-workflows/ci-scope-gaps.test.ts`)

1. `.github/actions/setup-project-bun/action.yml` matches a filter whose job's `if` reads it and
   whose steps use `./.github/actions/setup-project-bun`. Old shape: no filter matches: fails.
2. `native/remote-workspace-helper/src/main.rs` matches a filter whose job runs `cargo test` and
   `cargo clippy` against `native/remote-workspace-helper/Cargo.toml`. Old shape: fails.
3. Neither path matches the `ci` or `native` filters (no full suite, no macOS suite).
4. The executed aggregate block expects each job `requested` when its output is `true` and
   `not-requested` when `false`, and `GATED_JOBS` names both.
5. Both outputs come from the validation step, which can exit 1.

Path matching uses `Bun.Glob`, which follows the same `**` semantics as the filter for these
patterns.
