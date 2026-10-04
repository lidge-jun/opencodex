# 030 Phase 3 - land

1. `git fetch origin dev && git rebase origin/dev`; resolve conflicts in place.
2. Sync docs: `gui/design-system/components.md` (Claude tab is one page; Desktop has
   Models card + Advanced lanes), `structure/` doc that owns these GUI files if it names the
   rail or lanes, `docs-site` English page for Claude Desktop/Claude Code GUI if it describes
   the rail or lanes (translations must not contradict).
3. Gates: `cd gui && bun test tests && bun run lint && bun run lint:i18n && bun run build`;
   root `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`,
   `bun run test` (or focused set + recorded reason per AGENTS.md).
4. Screenshots of both tabs uploaded to the `pr-assets` branch, linked by commit SHA.
5. `gh pr create --base dev` using the template (Summary, Verification, Checklist).
6. Wait for exact-head required CI; fix findings; record maintainer integration decision
   and evidence; squash merge; confirm the merge commit on `origin/dev`.
7. Record the outcome in this unit and move it from `devlog/_plan/` to `devlog/_fin/` in the
   PR branch before merge.
