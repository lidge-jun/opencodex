# 050 Push preview main release

Do not fast-forward. ORIGIN=$(git remote get-url origin)

Before PR ready / merge to dev:
- bun test tests/usage-log.test.ts tests/api-usage.test.ts gui/tests/dashboard-contracts.test.ts
- bun run test
- bun run typecheck
- bun run privacy:scan
- if GUI changed: cd gui && bun test tests && bun run lint && bun run build
- PR body from .github/PULL_REQUEST_TEMPLATE.md; screenshot if title/body mentions gui

Then:
1. push branch, gh pr create --base dev, merge to origin/dev
2. PREVIEW_DIR=$(mktemp -d)/preview; git clone --branch preview "$ORIGIN" "$PREVIEW_DIR"; git -C "$PREVIEW_DIR" merge --no-ff origin/dev; git -C "$PREVIEW_DIR" push origin preview
3. live unused versions via npm view and gh release list (candidates 2.14.2-preview.20260813 and 2.14.2)
4. (cd "$PREVIEW_DIR" && bun scripts/release.ts <preview> --tag preview --publish); preview bump stays on preview
5. MAIN_DIR=$(mktemp -d)/main; git clone --branch main "$ORIGIN" "$MAIN_DIR"; git -C "$MAIN_DIR" merge --no-ff <origin/dev SHA before preview bump>; git -C "$MAIN_DIR" push origin main; (cd "$MAIN_DIR" && bun scripts/release.ts <stable> --tag latest --publish)
6. evidence: origin SHAs, npm dist-tag, gh release view
