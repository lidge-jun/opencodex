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

Landed as [#4151](https://github.com/lidge-jun/opencodex/pull/4151), base `dev`, head
`codex/readme-i18n-parity`, pushed with `--no-verify`. CI dispatched on the pushed head as run
`34405975400`.

`git push --no-verify -u origin codex/readme-i18n-parity`, then a pull request against `dev`
— never `main` — with `.github/PULL_REQUEST_TEMPLATE.md` filled: Summary, Verification,
Checklist. The Verification section carries the table above verbatim, including the NOT RUN
rows. No screenshot is required: the PR touches no `gui` surface.

Out of scope for this unit: merging, releasing, promoting to `main` or `preview`, and touching
`docs-site/` translations. If review asks for the docs site, that is a new work-phase.

## Guard non-vacuity record

Observed, not predicted.

| Mutation | Observed failure |
|---|---|
| the seven stale locale files, before the resync | 10 pass / 43 fail, each message naming the locale and the divergence |
| `sourceSha256` set to a dummy value for ko and ja | freshness failed naming both locales and printing the current README.md hash |
| `tr` removed from the manifest | registry failed naming the orphan file |
| a changed model id inside a fence | command parity differs while the translated prompt beside it does not |

## Two guard defects the locales found

Both were found by running the guard against a finished translation, not by review:

- The command-parity rule classified a quoted argument as prose only when it contained a space.
  Japanese and Chinese do not put spaces between words, so a translated example prompt read as an
  identifier and had to equal the English sentence. Non-ASCII now counts as prose.
- The link check required the English fragment on a localized URL, which no localized page has.
  It now compares the page and leaves the fragment to the locale.
