# 080 — WP8: publish the unit as a stacked pull-request chain

Plan phase for the final work-phase of the unit. WP7's artifacts exist but are
uncommitted; nothing has ever been pushed. This document is the diff-level map
for turning 24 local commits into a reviewable remote stack.

## State this plan starts from (measured, not remembered)

```
git rev-parse --abbrev-ref HEAD        -> dev
git rev-list --count origin/dev..HEAD  -> 0      (dev checkout carries no commits)
git rev-list --count HEAD..origin/dev  -> 3      (local dev is behind)
codex/codex-set-prompt-composer        -> 27b62a37f, 24 commits, NEVER pushed
merge-base(origin/dev, composer)       -> 779b6090c  (3 behind origin/dev 37e5dd5ec)
git status --short                     -> M docs-site/astro.config.mjs + 8 untracked guides
```

The consequence worth stating plainly: **there is no stack on the remote and
never was.** Earlier work-phases closed against local commits only. WP7's docs
were authored in the `dev` checkout, so they are not on the composer branch
either — `grep -c 'codexSet\.' gui/src/i18n/en.ts` returns 0 at this HEAD
because the GUI work lives on the other branch.

## Scope boundary

IN

- Rebase the 24 composer commits onto `origin/dev` (37e5dd5ec).
- Commit WP7's docs (English guide + 7 locale copies + sidebar entry).
- Slice the chain into 5 dependency-ordered branches, push each, open 5 PRs.
- Add the PR screenshots the repository gate requires for GUI layers.
- Verify each layer's own tests at its own tip.

OUT

- Base-instruction replacement flow (deferred, flagged; needs its own unit).
- `docs-site/src/content/docs/reference/configuration/` toggle-key reference:
  the five keys have no home there today (only `agents.md`, `providers.md`,
  `routing.md`, `server.md` exist) and inventing one is a separate decision.
- Merging anything. Stacks land bottom-up by the maintainer.
- `git reset --hard`, force-push to `dev`, or any promotion to `main`.

## Layer map (DEV-STACK-01: dependency order, never effort)

Five layers, not seven. WP5/WP6 collapse into one authoring layer and
WP6b/WP6c into one real-text layer, because neither half is independently
mergeable: WP6's preset picker writes through WP5's custom-layer store, and
WP6c renumbers the stack WP6b introduced.

| # | Branch | Commits | Thesis | GUI? |
|---|--------|---------|--------|------|
| 1 | `codex/prompt-layers-route` | 4b7bfdfce..ec1ac0a23 (3) | Serve prompt-layer state over `/api/codex-prompt` | no |
| 2 | `codex/prompt-layers-shell` | 04e3e7b15..a600254b1 (6) | Codex Auth becomes Codex Set; read the taxonomy | yes |
| 3 | `codex/prompt-layers-authoring` | 9c4eebb51..38e629401 (8) | Custom layers, drift repair, presets | yes |
| 4 | `codex/prompt-layers-realtext` | 4c3831d6e..27b62a37f (7) | Show the text Codex really sends; ordered stack | yes |
| 5 | `codex/prompt-layers-docs` | 1 new | Guide + 7 locales + sidebar | no |

Base refs: L1 -> `dev`; L2 -> L1; L3 -> L2; L4 -> L3; L5 -> L4.

Each layer's independent thesis, stated so a reviewer can check it:

1. **L1** adds one route module and its tests. The GUI never calls it yet, so
   merging L1 alone changes no user-visible behavior — it is a served endpoint
   with route tests. Verifiable alone.
2. **L2** renames the page and renders all fifteen layers read-only. Depends on
   L1 for its data; nothing above it is needed for it to be correct.
3. **L3** adds writes: custom layers, the linter, drift repair, presets.
4. **L4** replaces "Codex does not expose this" with the real probed text and
   turns the flat list into a numbered assembly stack.
5. **L5** is documentation only, and sits on top because it documents L4's final
   vocabulary (the numbered stack, the four absent-text reasons).

## Execution steps

### Step 1 — rebase onto current dev

```
git rebase --update-refs origin/dev codex/codex-set-prompt-composer
```

The three incoming commits (`c0533ce31`, `6bce1d1c8`, `37e5dd5ec`) touch the
web-search body-bounding path and cannot conflict with this unit's files. If a
conflict appears anyway, stop and report rather than resolving blind.

### Step 2 — cut the layer branches

```
git branch codex/prompt-layers-route     <rebased ec1ac0a23>
git branch codex/prompt-layers-shell     <rebased a600254b1>
git branch codex/prompt-layers-authoring <rebased 38e629401>
git branch codex/prompt-layers-realtext  <rebased 27b62a37f>
```

Branch creation, not reset: no commit is discarded and the composer branch stays
as the record of the original chain.

### Step 3 — WP7's commit, on top of L4

Switching to `codex/prompt-layers-realtext` carries the modified
`astro.config.mjs` and the 8 untracked guides across, because no commit in the
chain touches those paths. Then commit them and cut `codex/prompt-layers-docs`.

Note the count honestly: `070` specifies English + four locales (ja, ko, ru,
zh-cn) because that is what `astro.config.mjs` declared when it was written.
The site now carries seven (fr, tr, zh-tw added), and all seven are present, so
the delivered set is wider than the plan asked for. That is an amendment to
`070`, recorded here rather than left as a silent discrepancy.

### Step 4 — screenshots for the GUI gate

`.github/scripts/pr-quality.cjs` is the real gate, and reading it corrected an
error in this plan's first draft. The gate does **not** arm on a `gui` text cue
in the title or body — `hasGuiCue` exists but is not what fires the failure.
The armed condition is the changed-file list (`pr-quality.cjs:527-534`):

```
(guiPathsChanged(changedFilePaths) || filesTruncated) &&
  !hasScreenshotEvidence(body) && !hasGuiOverride(...)
  -> failures.push({ code: "missing_ui_screenshot" })
```

`guiPathsChanged` (`:176-180`) is true when any changed path equals `gui` or
starts with `gui/`. So the gate is decided by the diff, not by wording, and
**avoiding the word "gui" in a PR body cannot dodge it.**

Two consequences the first draft got wrong:

1. **The screenshot must be in each GUI PR's own body.** `hasScreenshotEvidence`
   reads only `body` (`:276-284`). Committing an image file into L2 gives
   L3/L4 the *file*, but their gate still inspects their own description. Each of
   L2/L3/L4 needs its own rendered `![...](...)` — inheritance buys nothing here.
2. **Committed asset or upload both work**, since evidence is any inline markdown
   image, a reference image with a definition, or an `<img src>` outside a fence
   (`stripNonRenderedRegions`, `:243-255`, strips fences BEFORE comments). A
   plain link to an image is explicitly not evidence.

Chosen approach: commit three assets under `docs-site/public/pr-screenshots/`
in the **L2** range (repository precedent: `1073-context-window-controls.jpg`),
then reference the raw.githubusercontent URL from each of the three GUI PR
bodies. One upload path, three descriptions. Screenshots are re-taken from the
live dashboard rather than trusted from stale `/tmp` timestamps.

L1 and L5 change no `gui/` path, so the gate never arms for them.

### Stacked bases are supported by the gate (verified)

`enforce-pr-target.yml:535-556` paginates open PRs and sets `stackedBase` when
this PR's base ref equals another **open** PR's head in the same repo.
`pr-quality.cjs:497` then skips `wrong_base`, and `:505-508` skips the ancestry
heuristic too. A closed or missing parent falls back to `wrong_base`, which is
the cascade risk if a lower layer merges before an upper one is retargeted.

### Step 5 — push and open

Push with `--no-verify` (user-approved this session), `-u` on each branch.
PRs via `gh pr create --base <layer below>`, each body filling all three
template sections plus the DEV-STACK-03 stack map with "you are here".

## Accept criteria

| # | Criterion | Evidence |
|---|-----------|----------|
| 1 | Every layer contains only its own diff | `git log --oneline <below>..<layer>` shows exactly the mapped commits |
| 2 | Chain rebased onto current dev | `git merge-base --is-ancestor origin/dev codex/prompt-layers-docs` exits 0 |
| 3 | Each layer's tests pass at its own tip | narrow `bun test` on that layer's own files |
| 4 | 5 PRs open with correct base refs | `gh pr list --json baseRefName,headRefName` shows the chain |
| 5 | GUI layers pass the screenshot gate | each GUI PR body renders a markdown image outside a fence |
| 6 | No repository-wide local test run | narrow `bun test <file>` invocations only |

## Loop spec

- Archetype: spec-satisfaction repair. The verifier is `gh pr list` plus
  per-layer `bun test`; done is defined by the six criteria above.
- Verifier: git ancestry checks, narrow bun test, `gh pr view` per layer.
- Stop condition: five PRs open, correct bases, per-layer tests green.
- Write scope: this repository's `origin` refs, 5 new remote branches, 5 PRs.
  No writes to `dev` or `main`.
- Escalation: a rebase conflict, a rejected push, or a gate failure needing a
  maintainer label stops the phase and reports rather than working around it.
- Terminal outcomes: DONE when all six criteria hold; BLOCKED if the remote
  refuses a push or CI requires maintainer action.
