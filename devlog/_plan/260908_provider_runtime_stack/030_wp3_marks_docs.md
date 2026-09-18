# 030 — wp3: L4 marks/docs/credits, L5–L6 secondary layers

L4 `codex/prs-l4-marks-docs` (maintainer-authored):

- `gui/public/provider-icons/qoder.svg` from `/tmp/ocx-marks/qoder.svg` (verbatim).
- `gui/src/provider-icons.ts`: aliases `qoder`/`qoder-cn` → `qoder.svg`; display names
  Qoder, Qoder CN, CodeBuddy, CodeBuddy CN. No CodeBuddy asset (012).
- `gui/public/provider-icons/README.md`: Qoder provenance + CodeBuddy refusal note (012 text).
- `docs-site/src/content/docs/guides/providers.md`: "Official Qoder CLI (Global & CN)"
  section after the CodeBuddy section; reference/configuration adapter list adds `qoder`.
- `CREDITS.md`: not needed — original commits keep the contributor as author.

L5 `codex/prs-l5-hermes-yaml`: cherry-pick -x `a1fe9caeb` (#3990, rrmlima).
L6 `codex/prs-l6-gemini-tail`: cherry-pick -x `1837b8f99` (#3988; commit author is
`root`, so add `Co-authored-by: rrmlima` via the PR body/merge commit).
