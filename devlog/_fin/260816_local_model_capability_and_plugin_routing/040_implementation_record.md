# 040 — Implementation record and verification evidence

Terminal outcome: **DONE**. All three objectives implemented, verified, pushed,
and opened as PR #1799 against `dev`.

## What shipped

| Change | File | Commit |
|--------|------|--------|
| Provenance stamp sourced from CatalogModel + generated metadata, context-cap aware, combo-excluded | `src/codex/catalog/effort.ts` | c435340bb |
| Shared generated-metadata lookup export | `src/codex/catalog/parsing.ts` | c435340bb |
| Provenance reader; unconditional adapter tool fallback | `src/routing/capability.ts` | c435340bb |
| `supportsImages` tri-state restored | `src/providers/antigravity-models.ts` | c435340bb |
| `meta.n_ctx` / `n_ctx_train` as context sources | `src/codex/catalog/provider-fetch.ts` | cc3512ed0 |
| 10 regressions | `tests/routing-capability-catalog.test.ts` | c435340bb |
| 4 regressions | `tests/catalog-llamacpp-capabilities.test.ts` | cc3512ed0 |
| Plugin routing guidance | `AGENTS_INSTALL.md` | (this commit) |

### Where the plugin guidance lives (review correction)

The first draft of this record listed `~/.codex/AGENTS.md` as a shipped
change. That was wrong on its own terms: the file is untracked host state, so
it is not part of the PR and cannot be reproduced from a clone. CodeRabbit
caught it, and the fix is the honest one — the guidance now lives in the
tracked `AGENTS_INSTALL.md`, which is precisely the file an agent installing
or operating opencodex reads.

The host file remains as a local convenience and is recorded here as
host-only verification, not as a deliverable. The live check
(`codex debug prompt-input | rg mcp__node_repl__js`, exit 0) proved the
guidance reaches a model through the host path; the tracked copy is what
makes it reproducible for everyone else.

## Activation grounding (C-ACTIVATION-GROUNDING-01)

Both suites were run against the tree with the source changes stashed, proving
they observe the defect rather than passing vacuously:

| Suite | Without fix | With fix |
|-------|-------------|----------|
| `routing-capability-catalog` | 5 pass / 5 fail | 10 pass / 0 fail |
| `catalog-llamacpp-capabilities` | 1 pass / 3 fail | 4 pass / 0 fail |

The llama.cpp matrix matches what audit round 6 predicted exactly: tests 1, 2
and 4 red before, test 3 (the precedence guard) green either way.

## End-to-end proof

With the `lidge` provider's inline capability maps deleted — the exact state of a
user who only ran `ocx models add` — the catalog is the sole evidence source:

    before: {"tools":true,"serviceTier":"unsupported","encryptedCodexTasks":false}
    after:  {"contextWindow":262144,"image":true,"tools":true,...}

The provenance block written for that row:

    {"provider":"lidge","model_id":"qwen3.8-27b-nvfp4",
     "context_window":262144,"input_modalities":["text","image"]}

## Remote exact-head suite

Run in an isolated scratch clone at `cc3512ed0`, per the three-step block in
`010`/`020`:

    12337 tests across 792 files — 11 skip, 7 fail, 461.65s

All 7 failures are `Cannot find package 'react'` / `react/jsx-dev-runtime` from
`gui/` sources, because the scratch clone installs no GUI dependencies. The
failing files are `gui-management-session`, `provider-workspace-data`,
`tencent-siliconflow-providers`, `usage-surfaces`, `vision-sidecar-timeout-bounds`,
and `volcengine-providers` — none touch routing, catalog, or Antigravity. Audit
round 6 independently reproduced the same seven on an unmodified `dev` checkout.
Both new suites passed on the remote host.

## CI (PR #1799)

21 checks pass, including `enforce-target`, `gates`, `hygiene`, `react-doctor`,
`api usage`, all four `test` shards, and every `keyring`/`npm-global` matrix job.

Two fail: `macos` and `ci`. The macOS job is a **Bun runtime segfault**, not a
test failure — the workflow classifies it explicitly:

    RSS: 3.40GB | Peak: 3.63GB | Machine: 7.52GB
    panic: Segmentation fault at address 0xFFFFFFFFFFFFFFE8
    oh no: Bun has crashed. This indicates a bug in Bun, not your code.
    ::error::Bun runtime crash repeated on the macOS suite; failing after one retry.

The latest `dev` run (31902897010) fails the same two jobs for the same reason,
so this is pre-existing and not introduced here.

## Scope honesty

The image half of #1797 is NOT fixed. `extractProviderModelItems` reads only
`data[]` envelopes by explicit design, so the `multimodal` token in `models[]` is
discarded, and even a merged item would stay image-unknown because `multimodal`
is not a recognized capability string. Test 4 of the llama.cpp suite
characterizes that gap so the follow-up has a live witness rather than a prose
claim.

## Deferred

`cxc orchestrate` could not record the A>B transition: REVIEW-BINDING-01 accepts
a verdict only from a `SubagentStop` hook requiring `agent_type: "explorer"`, and
this host's rollout emits `SubagentStop` without that field (see `004`). The hook
was untrusted as well and was fixed with `cxc hooks retrust`, but the payload gap
remains. Fabricating the payload would defeat the exact self-attestation boundary
the rule exists to enforce, so the FSM stayed at A while the work proceeded with
its evidence recorded here.
