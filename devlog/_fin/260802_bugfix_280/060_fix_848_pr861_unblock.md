# 060 — #848: PR #861 macOS CI diagnosis (resolved at research time)

Diagnosis (investigator Laplace, verified): the macOS CI failure on PR
#861 is the known Bun-on-macOS isolate segfault, not a PR defect.

- Failing job: run 30710653575 (`bun test --isolate`), crashed in
  tests/storage-worker-lifecycle.test.ts with `panic: Segmentation fault`,
  no JS stack, exit 133.
- Ancestry: PR head f6d7d1cf does NOT contain #849 (18352b4f,
  macos-isolate-worker-segfault); the failed CI merge used base aae9426e,
  predating #849.

Action taken 2026-08-02: posted the diagnosis + exact unblock action on
#861 (comment 5154392437): rebase `fix/848-bun-runtime-provenance` onto
current dev (past 18352b4f) and let CI rerun; review is otherwise complete
on the maintainer side.

Outcome: DONE — no local code change needed; the issue's fix rides PR
#861 once rebased.
