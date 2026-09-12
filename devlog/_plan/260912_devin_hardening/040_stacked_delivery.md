# wp5 — Stacked delivery

Four branches, each one PR, chained so a reviewer sees one concern at a time.

    dev
     └── codex/260912-devin-cli-token-transition     (wp2)
          └── codex/260912-devin-cloud-direct-hardening  (wp3)
    dev
     └── codex/260912-cached-token-companion         (wp4)

wp4 is a sibling of the Devin chain, not a child: it touches `gui/src` and `src/cli` only and
shares no file with wp2 or wp3.

Rules carried from the repository:

- Every PR fills `.github/PULL_REQUEST_TEMPLATE.md` in full and targets its parent branch;
  children retarget to `dev` once the parent lands.
- Pushes use `--no-verify`; the local product suite is not run. Remote CI on the exact final
  head is the evidence, and any skipped local check is labelled NOT RUN.
- Merges into `dev` are serialized, parent first, and each child is rebased onto the moved
  parent before its own merge.
- A PR whose title or description mentions `gui` needs a screenshot, so wp4's description
  avoids that word unless a screenshot is attached.

