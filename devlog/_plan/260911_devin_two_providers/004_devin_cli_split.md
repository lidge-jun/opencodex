# 004 — wp5: splitting devin-cli out

The wp4 audit recommended splitting, citing MAINTAINERS.md: a new canonical
registry destination is a maintained promise, and when the evidence is incomplete
the repository wants an inert directory row rather than a registry entry. The
cloud `devin` provider cannot complete a turn on the account we can measure.
`devin-cli` does not share that RPC.

## What moved

Branch `codex/260912-devin-cli-provider` from a freshly fetched `origin/dev`
(`29d632ff25`). It carries `src/adapters/devin-cli/` and
`tests/providers/devin-cli-adapter.test.ts` byte-identical, plus only the
`devin-cli` hunks of the adapter registry, the provider registry, the routing
behaviour table, the layout map and the membership fixture. Docs get the English
provider row and adapters section and the provider row in all seven locales.

The tool-conformance skip lists needed care: on the other branch they name both
wires, and here only `devin-cli` exists, so naming a wire that is absent would
have been a silent no-op rather than a skip.

## What stayed

Everything cloud-direct: `src/adapters/devin/`, `src/oauth/devin*`, the `devin`
registry entry and its documentation, the MIT notice for the derived files, and
this plan unit. PR #4285 keeps them.

## Verification

`bun x tsc --noEmit` clean; 76 focused tests pass; `privacy:scan` green. An
independent audit of the split diff (21 files, +925/-5) found no cloud-provider
leakage, agreeing registries, resolving imports, and a PR description that
matches the code. Remote CI on the exact head is the suite gate.
