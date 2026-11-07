# Work-Phase 4 (`wp4`): SoT Docs Sync, `pr-assets` UI Screenshots, Full Gates, and Stacked PR Delivery

> Depends on: `000_roadmap.md`, `010..030`.

## 1. File Change Map

| Action | Path | Summary |
|---|---|---|
| MODIFY | `structure/remote-link.md` | Update present-tense contract under `## Ephemeral Rust Child (ocx-child)` to document `src/link/child-binary-source.ts`, `src/link/remote-plant.ts`, `allowMissing` host inspection, `POST /api/link/apply` (`plant: true`) SSH `stdin` planting & rollback, `--purge` managed-path removal, `LinkRecord.childKind`, and `child_port_busy` / `child_external_provider_conflict` |
| MODIFY | `docs-site/src/content/docs/guides/remote-link.md` (and matching locale pages if present) | Document zero-preinstall SSH Child onboarding (`#remote` Ready-to-Plant & `ocx link add <alias> --plant`), two-tier disconnect (`--purge`), and conflict troubleshooting |
| EXTERNAL | `origin/pr-assets` (`pr-ocx-child-ux/*.png`) | Commit and push 3 crisp `#remote` UI screenshots ONLY to `origin/pr-assets` via a temporary git worktree outside the repo tree (zero image files on `feat/ocx-child-plant-ux`) |

## 2. Execution & Delivery Steps

1. **Documentation & SSOT gates**:
   - Update `structure/remote-link.md` naming `src/link/child-binary-source.ts`, `src/link/remote-plant.ts`, and `tests/clients/link-child-plant-foundations.test.ts`; stage new files with `git add` and verify `bun run structure:check` (`exit 0`).
   - Inspect `rg -l "remote-link|ocx-child" docs-site/`, update user-facing Remote Link docs, and verify `cd docs-site && bun run build` (`exit 0`).
2. **Full Local Verification Floor**:
   - `cargo test --locked --manifest-path native/ocx-child/Cargo.toml`
   - `cargo build --release --locked --manifest-path native/ocx-child/Cargo.toml`
   - `cd gui && bun run lint:i18n && bun run lint && bun test tests && bun run build`
   - `bun run build:gui`
   - `bun run typecheck`
   - `bun test tests/clients/link-*.test.ts tests/server/link-*.test.ts tests/cli/cli-link*.test.ts tests/ci-workflows/file-size-ratchet.test.ts tests/ci-workflows/repo-hygiene.test.ts tests/ci-workflows/structure-ssot.test.ts tests/ci-workflows/skill-ocx.test.ts tests/lab/core-lab-boundary.test.ts tests/lab/core-link-boundary.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts`
   - `bun run test:changed`
   - `bun run privacy:scan`
3. **Real UI Screenshot Capture & `origin/pr-assets` Upload (`C-RENDER-GROUNDING-01`)**:
   - Serve built `gui/dist` locally with deterministic `/api/link/*` fixtures and render in headless browser / GOAT browser at `1280x800`, capturing into `/tmp/ocx-child-ux-shots/`:
     1. `01-ready-to-plant-modal.png` (Add Child sheet after fingerprint check showing Ready-to-Plant card + CTA)
     2. `02-connected-children-badges.png` (Connected Children list showing Lightweight / Full mode badges & Home settings synced / Sync needed parity badges)
     3. `03-ephemeral-disconnect-purge.png` (Disconnect confirmation modal with fast-detach explanation and `--purge` checkbox checked)
   - Visually inspect every screenshot with `view_image` (`C-RENDER-GROUNDING-01`) to verify crisp typography, spacing, contrast, and zero clipping/i18n leaks.
   - Fetch `origin/pr-assets`, check out a detached temporary worktree in `mktemp -d`, place PNGs under `pr-ocx-child-ux/`, commit, push `HEAD:refs/heads/pr-assets`, record immutable `<pr-assets-sha>`, and remove the temporary worktree. Verify `git status` on `feat/ocx-child-plant-ux` has zero image files!
4. **Stacked Pull Request Publication & Watch (`DEV-STACK-03`)**:
   - Check `gh pr view 8237 --json state,headRefName,headRefOid`:
     - If `OPEN`: verify `git merge-base --is-ancestor <headRefOid> HEAD`, push `feat/ocx-child-plant-ux`, and open stacked PR with `gh pr create --base feat/ocx-child-ephemeral-link --body-file <mktemp>` including the `DEV-STACK-03` stack table, Summary, Verification, Checklist, and embedded `https://raw.githubusercontent.com/lidge-jun/opencodex/<pr-assets-sha>/pr-ocx-child-ux/*.png` screenshots.
     - If `MERGED`: rebase cleanly onto `origin/dev`, re-verify gates, push, and open PR with `--base dev`.
   - Call `goat_pull_request_link`, watch via `goat_pull_request_watch` until required exact-head checks and automated reviews complete, address any valid findings, record `cxc loop pr-record --session 01a1b2d6-b6ca-76c3-8e6c-e00f7449b965 --pr <url>`, run `cxc loop validate`, call `goat_pull_request_unwatch`, and leave PR unmerged.

## 3. `wp4` P-Phase Continuity & Architect Reflection Amendments (`01a1b33c-63c3-7410-9ced-7be53251867e`)

- **Continuity from `wp3` D**: Resumed from `wp3` D conclusion ("Next cycle wp4 syncs structure/ + docs-site/, captures #remote screenshots to origin/pr-assets, opens the stacked PR, watches CI/reviews, and records pr-record").
- **Architect `01a1b33c-63c3-7410-9ced-7be53251867e` verdict**: `ALIGNED` on `W4-ARCH-01..W4-ARCH-03`.
- **Folded guards**:
  1. Edit `structure/remote-link.md` `## Ephemeral Rust Child (ocx-child)` in-place (replacing `409 child_restart_unsupported` with `409 child_port_busy`, documenting `409 child_external_provider_conflict`, `src/link/child-binary-source.ts`, `src/link/remote-plant.ts`, `--purge`, and `LinkRecord.childKind`, and keeping total line count comfortably below `manifest.json` cap).
  2. Include `bun run skill:surface:check` and `tests/ci-workflows/docs-link-targets.test.ts` in the `wp4` verification floor.
  3. Update `docs-site/src/content/docs/guides/remote-link.md` and `docs-site/src/content/docs/ko/guides/remote-link.md` (plus check locale pages for non-contradiction).

