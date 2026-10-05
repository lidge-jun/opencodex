# 030 Phase 3 - land

1. `git fetch origin dev`; rebase on it if it moved; resolve conflicts in place.
2. Sync docs: `gui/design-system/components.md` (Claude tab is one page; Desktop has
   Models card + Advanced lanes), `structure/gui-and-management-api.md` (owns
   ClaudeDesktop.tsx), the English `docs-site` Claude guide (Desktop profile section, GUI
   section, and every stale `Claude → Code/Desktop` navigation path), and the same
   navigation paths in the seven translated guides so none contradicts the GUI.
3. Gates: `cd gui && bun test tests && bun run lint && bun run lint:i18n && bun run build`;
   root `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`,
   `bun run test` (or focused set + recorded reason per AGENTS.md);
   `cd docs-site && bun install --frozen-lockfile && bun run build`.
4. Record the outcome in this unit and move it from `devlog/_plan/` to `devlog/_fin/` in the
   final commit, before push.
5. Screenshots of both tabs uploaded to the `pr-assets` branch, linked by commit SHA.
6. `gh pr create --base dev` using the template (Summary, Verification, Checklist).
7. Wait for exact-head required CI; fix findings; record the maintainer integration
   decision and evidence; squash merge; confirm the merge commit on `origin/dev`.
