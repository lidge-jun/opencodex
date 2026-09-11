# 030 — WP4: docs, locale parity, and the stack

## Stack shape

The user asked for stacked PRs ("stack pr로 해", "계속 head dev에 커밋해서 원격 pr을
stack으로 쌓으라니까"). The chain, each branch based on the one above it:

```
dev
 └── codex/pkgtree-503            WP1 fix: H1 + H2, the availability regressions
      └── codex/prompt-write-auth  WP1 fix: H5, then H3/H4 config-corruption fixes
           └── codex/git-attribution     WP2
                └── codex/base-variants  WP3
                     └── codex/prompt-docs   WP4 docs + locales
```

Retarget rule, learned the hard way in the parent unit: `enforce-pr-target.yml:535-556`
skips `wrong_base` only while the parent PR is OPEN. So each child is retargeted to
`dev` BEFORE its parent merges, never after.

Gate rule, also learned there: `.github/scripts/pr-quality.cjs:527` arms the
GUI-screenshot requirement from CHANGED FILE PATHS under `gui/`, not from the word
"gui" in the title, and `hasScreenshotEvidence` reads only the PR body. So every PR
touching `gui/` needs its own inline image; inheriting a committed asset does nothing.

Verification rule, the one that cost 13 CI jobs last time: test EVERY branch of the
stack, not just the head. i18n keys used at layer 3 but defined at layer 4 typecheck
fine at the tip and fail at the intermediate commit.

```
for B in pkgtree-503 prompt-write-auth git-attribution base-variants prompt-docs; do
  git switch codex/$B
  (cd gui && bun x tsc -b --force) && (cd gui && bun run lint)
  bun x tsc --noEmit
done
```

## Docs

`docs-site/src/content/docs/<locale>/guides/codex-prompt.md` in en, ja, ko, ru, zh-cn
(the five the parent unit's WP7 established; zh-tw, fr and tr already carry the file
and stay consistent).

Two additions per locale:

- A `Commit attribution` row in the layer table, stating that Codex resolves it from
  the account and that turning it off at the account level sends the opposite
  instruction rather than nothing.
- A `Base prompt variants` section: what the three variants are, that variant 1 is the
  absence of `model_instructions_file` rather than a copy of Codex's prompt, that
  variants 2 and 3 REPLACE the base prompt entirely, and that swapping applies to
  newly started sessions like every other prompt change.

The replacement warning is the load-bearing sentence. A user who does not understand
that variant 2 removes Codex's own instructions will write a two-line prompt and
wonder why the agent stopped working.

## SoT sync (SOT-SYNC-01)

`structure/` carries the maintainer invariants. The prompt composer's own invariants
live in its module header rather than in `structure/`, and this unit adds one worth
recording there: `model_instructions_file` is now WRITABLE by opencodex, which
reverses a documented refusal. That reversal goes in the same PR as the code, not a
follow-up.

## Final gate

```
bun x tsc --noEmit
cd gui && bun x tsc -b --force
bun test ./gui/tests/
bun test tests/codex-prompt-layers.test.ts tests/codex-prompt-route.test.ts \
         tests/codex-prompt-base-variants.test.ts tests/package-tree-integrity.test.ts
bun run lint:gui
bun run privacy:scan
git diff --check
```

Never the full suite locally. Anything heavier goes to CI or `ssh lidge-ai` /
`ssh clisu-oracle`. Every commit and push uses `--no-verify`.

## Merge close-out

```
gh pr checks <n>                                  # per PR
gh pr merge <n> --merge --admin                   # parent before child
gh pr list --author lidge-jun --state open        # must end []
git rev-list --count dev..origin/dev              # must be 0
git rev-list --count origin/dev..dev              # must be 0
```
