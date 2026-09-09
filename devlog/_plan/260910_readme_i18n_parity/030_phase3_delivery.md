# wp4 — delivery

## Branch and commits

Branch `codex/readme-i18n-parity` off the current `dev` head (`5669b96b7`), in the managed
worktree `/Users/jun/.codex/worktrees/c0a4/opencodex`, which starts detached. Adopt in place
with `git switch -c`; do not move or recreate the worktree.

Three scoped commits:

1. `test(readme): guard non-English READMEs against drift` — the manifest, the guard test and
   both test-layout registrations.
2. `docs(readme): resync every non-English README to the current English source` — the seven
   locale files and their refreshed `sourceSha256`.
3. `docs(devlog): record the README i18n parity unit` — this unit.

## Verification contract

The user forbade the local product suite for this task and asked for a `--no-verify` push.
What that means concretely, and what the PR description must say:

| Check | Status |
|---|---|
| `bun run test` (full suite, ~850 files) | NOT RUN — forbidden for this task |
| `bun run typecheck` | NOT RUN — forbidden for this task |
| `bun run build:gui`, `bun install` | NOT RUN — forbidden for this task |
| `bun test tests/ci-workflows/docs-readme-translation-parity.test.ts` | run — the new guard only |
| Remote CI on the pushed head | authoritative evidence |

Running the one new file is not the local suite: it is the smallest proof that the guard this
PR adds is not vacuous, and shipping an unexecuted guard would spend more of the user's time
than it saves. Everything else stays NOT RUN and is labelled as such rather than implied green.

## Push and PR

`git push --no-verify -u origin codex/readme-i18n-parity`, then a pull request against `dev`
— never `main` — with `.github/PULL_REQUEST_TEMPLATE.md` filled: Summary, Verification,
Checklist. The Verification section carries the table above verbatim, including the NOT RUN
rows. No screenshot is required: the PR touches no `gui` surface.

Out of scope for this unit: merging, releasing, promoting to `main` or `preview`, and touching
`docs-site/` translations. If review asks for the docs site, that is a new work-phase.

## Guard non-vacuity record

Filled during wp2 with the observed red output for each mutation.

| Mutation | Expected failure |
|---|---|
| delete one `## ` section from a locale | skeleton token stream mismatch at index N |
| change `ocx start` to `ocx run` in a locale fence | command mismatch, fence 1 line 2 |
| edit `README.md` without refreshing the manifest | freshness failure naming all seven locales |
| drop a locale from the manifest | registry mismatch naming the orphan file |
