# A round 1 synthesis — `VERDICT: FAIL`

Reviewer: Nash (`019f6f3e-b45d-71d2-ace0-f554d6f5d103`). The first Boole dispatch was retired as a silent failure after three bounded waits and produced no findings.

## B1 — 111 multi-owner rows

- Root cause: `004_generate_hunk_ledger.mjs` classified shared files by path, allowing one source hunk to claim several children.
- Decision: accept.
- Amendment: every ordinary row now has one child. The nine indivisible mixed hunks use `rewrite-fanout` with one `003/*` owner and a separate `001_hunk_fanout.tsv` containing uniquely owned symbol/selector/key groups. Parent fan-out rows receive no child credit.
- Proof target: 764 rows, zero `child_ids` containing `|`, all fan-out parents exist, all 63 subrows have one numeric child.

## B2 — WP010 source selection mixed contract and copy

- Root cause: all hunks in four files were assigned to 010 even though `derive.ts`, `registry.ts`, and parity tests also contained label/note copy changes.
- Decision: accept.
- Amendment: exact source ordinals `220-223`, `234`, `241-242`, and `255-257` map to 010. Copy/test hunks `224-225`, `235-240`, `270-271` map to 100. WP010 explicitly labels its NVIDIA/propagation assertions as maintainer repair tests, not source hunks.
- Proof target: WP010 has 10 exact source rows; no label-only source row maps to 010.

## B3 — deferred splits in 090/140/150

- Root cause: roadmap treated the 500-line gate as a future decision instead of pre-writing known material splits.
- Decision: accept.
- Amendment: 090/091 separate overview from settings/auth; 140/141 separate Dashboard from Usage; 150-154 split ClaudeCode, Debug, Logs, ApiKeys/CodexAuth, and Subagents. Goalplan receives the matching work-phases and criteria before re-audit.
- Proof target: no decade doc says “select/split before B”; each new sub-doc has exact paths, before/after, commands, rollback, and attribution inherited from `000`.

## B4 — placeholder tests/commands

- Root cause: several docs named a test concept but not its path/command.
- Decision: accept.
- Amendment: exact owners are `tests/provider-connection-test.test.ts`, `tests/provider-api-keys.test.ts`, `tests/provider-workspace-data.test.ts`, `tests/provider-workspace-state.test.ts`, `tests/ci-workflows.test.ts`, `tests/update-job.test.ts`, `tests/update-notify.test.ts`, `tests/update-stop-first.test.ts`, `tests/anthropic-image-normalize.test.ts`, and `tests/cursor-transport-retry.test.ts`. Every gate is a shell command; prose-only `action pin/permission audit` is removed.

## Medium findings

- `140-H488` now records the accurate scope decision: a valid Windows xAI flake stabilization deliberately excluded from this stack.
- The docs-only acceptance criterion now relies on the global attribution contract; individual decade docs need not repeat it.

## Cross-blocker conflict check

Unique hunk ownership and pre-splitting reinforce each other: the new 090/091, 140/141, and 150-154 IDs are used by the fan-out sub-ledger. Exact test paths are assigned to their final owner, avoiding duplicate tests across children. No accepted blocker requires changing immutable refs or importing the integration trees.
