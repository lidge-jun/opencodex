# Batch 8 — plan

Previous D: #5936 (`bb3f3c2d0d`) fixed the title bar layout defects and the `tests/cli` batch hang. The next step is to
carry the new bug PRs that the post-merge triage (Sol, read-only) classified as carry-with-fix.

## Carry

- #5929 (@mdwsk88): CodeBuddy parallel tool-use blocks are serialized without corrupting calls. Prepared on
  `codex/bug-train-8-prep`: `5edec14b73` (squashed carry with author and `Co-authored-by`) and `df7ca1df3d` (P1 fix).
  The P1 was a bridge-init check that ran when a buffered tool call closed. It now runs on the raw start frame, before
  buffering. The start → init → stop regression is red before the fix and green after it.
- #5929 audit follow-up: with more than one tool block open, an indexless tool-argument delta fails the turn instead
  of being dropped (the parser's fail-closed contract).
- CI: the `macos control` lane hung in `tests/ci-workflows/ci-privacy-gate.test.ts` (`spawnSync` child) on `dev` at
  `bb3f3c2d0d`; same bounded treatment as #5936 if the logs confirm the same class.

## Left out

- #5927: the independent security review failed, so it is not carried. The finding is kept in scratch space for the
  maintainers, not in this tracked plan.
- #5925 duplicates #5929's four CodeBuddy files, and its MCP-only half needs a rebase and its own security review for
  undeclared-tool admission.
- #5926 and #5928 are owner PRs.

## Check

Focused adapter and image suites, layout, file-size and structure guards, tsc, privacy. The #5927 security review is
recorded on the batch PR. Exact-head CI, then `--admin --match-head-commit`. Close the carried PRs with the batch note.
