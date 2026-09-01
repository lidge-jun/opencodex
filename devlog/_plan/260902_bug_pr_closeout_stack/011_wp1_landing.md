# 011 — wp1 landing record: PR #3163

## Landed

- PR: #3163 `ingw/fix-copilot-context-3156` by @Ingwannu
- Head audited: `486b2f99f3182acf055274755ade9c6571203ac9`
- Merge SHA on `dev`: `e236c36239c93f006a706aba3e7c84da167b5dd9`
- Mechanism: `gh pr merge 3163 --squash --admin --delete-branch`
- Closes: #3156 (closed manually — PRs target `dev`, not the default branch, so
  GitHub does not auto-close)

## Evidence at merge time

`gh pr checks 3163` — 23 checks, every one `pass`, on the audited head. No waived check.

## Ancestry proof

    git fetch origin dev
    git merge-base --is-ancestor e236c36239c93f006a706aba3e7c84da167b5dd9 FETCH_HEAD
    # exit 0

## What changed in the product

`src/codex/catalog/provider-fetch.ts` now reads GitHub Copilot's live context window from
`capabilities.limits.max_context_window_tokens`. Before this, that field was unrecognized and
Copilot models fell back to the conservative 128K window. Existing metadata precedence and
the safe-integer rejection of malformed values are unchanged;
`tests/codex-catalog.test.ts` covers accepted, conflicting, and invalid payloads.

