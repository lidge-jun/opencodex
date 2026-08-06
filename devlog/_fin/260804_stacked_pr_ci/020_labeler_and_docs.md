# 020 — Phase 2: label coverage for unrecognised title prefixes, and the docs

Depends on: `010` (both edit `tests/ci-workflows.test.ts`).

## What is actually broken

Not the stacked shape. `pr-labeler.yml` has no `branches:` filter, so it runs on
stacked children exactly as it does anywhere else — the `label` check-run is
present on all four stack PRs and reports success.

The gap is the title vocabulary. `detectTypeLabelFromTitle()` matches a prefix
word, then looks it up in `PREFIX_TO_LABEL`; an unknown word returns `null` and
`planTypeLabelSync` returns `{ skip: true, reason: "no-prefix" }`. Verified:

```
"stack 1/5: triage the open issue surface and lock the bug plan"
  -> { skip: true, reason: "no-prefix" }
```

Note the shape of the failure, because it is not the obvious one. The
conventional-commit regex `^([a-zA-Z]+)(\([^)]*\))?!?\s*:` does **not** match
`stack 1/5:` — the `1/5` sits between the word and the colon. Verified:

```
"stack 1/5: triage...".match(conventional) -> null
"stack 1/5: triage...".match(sentence)     -> ["stack 1", "stack"]
```

So it is the *sentence-case fallback* that captures `stack`, which is then
dropped at the `PREFIX_TO_LABEL` lookup. Either way the result is a skip, and a
skip is not an error — the check stays green and the PR silently carries no type
label. All four stack PRs have empty label sets.

The underlying commits are correctly prefixed (`fix(usage):`, `fix(codex):`,
`test(codex):`). Only the PR titles use the stack vocabulary.

## Design decision

Rejected: adding `stack` to `PREFIX_TO_LABEL`. There is no correct type for it —
a stack PR can carry fixes, features, or docs — so any mapping would be a lie,
and it treats one team's naming habit as a repository-wide vocabulary.

Rejected: falling back to the branch name. `codex/915-cooldown-recovery-probe`
has no type information either.

**Chosen:** when the title yields no type, fall back to the PR's own commit
messages. The commits are conventional even when the title is not, and they are
the most faithful available statement of what the PR contains.

### The unanimity rule, and why it had to change (wp3 audit)

The first draft required unanimity: apply the type only if every typed commit
agrees, else skip. The audit ran it against the real stack and it failed the
very PRs it was written for:

```
#952 -> { bug: 1 }          unanimous -> "bug"
#955 -> { bug: 4, chore: 1 } NOT unanimous -> skip
```

#955 is four `fix(codex):` commits plus one `test(codex):`. It is a bug-fix PR
by any honest reading, and a rule that abstains there is a rule that abstains on
most real PRs — almost every substantial change carries a test or chore commit
alongside its feature or fix.

So `chore` is treated as **supporting**, not competing. `test:`, `ci:`,
`chore:`, `style:`, `refactor:`, and `build:` all map to `chore`, and none of
them describes what a PR is *for*; they describe work that accompanies it.

Final rule:

1. Drop `chore` from the tally when any non-`chore` type is present.
2. If exactly one type remains, apply it.
3. Otherwise skip — a PR genuinely mixing `fix:` and `feat:` has no single
   honest type, and inventing one is worse than leaving it unlabeled.

An all-`chore` PR still gets `chore`, since step 1 only fires when something
else is present.

## Change 1 — MODIFY `.github/scripts/pr-labeler.cjs`

Add an exported helper next to `detectTypeLabelFromTitle`:

```js
/**
 * Type from the PR's commits, for titles the title matcher cannot classify.
 *
 * A PR titled `stack 3/5: carry six contributor bug fixes` reaches the
 * sentence-case fallback, which extracts `stack`; that has no entry in
 * PREFIX_TO_LABEL, so the sync skips and the PR carries no type label while the
 * `label` check stays green. Its commits are conventional (`fix(codex): ...`),
 * so they can answer the question the title cannot.
 *
 * `chore` is supporting, not competing. `test:`/`ci:`/`chore:`/`style:`/
 * `refactor:`/`build:` all map to it, and none of them says what a PR is FOR —
 * requiring unanimity would abstain on almost every real PR. #955 is four
 * `fix(codex):` commits plus one `test(codex):`; it is a bug fix.
 *
 * Anything still ambiguous after that (`fix:` plus `feat:`) is left unlabeled
 * rather than guessed.
 */
function detectTypeLabelFromCommits(messages) {
  const types = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    const detected = detectTypeLabelFromTitle(String(message || "").split("\n")[0]);
    if (detected) types.add(detected);
  }
  if (types.size > 1) types.delete("chore");
  return types.size === 1 ? [...types][0] : null;
}
```

And extend `planTypeLabelSync` to accept `commitMessages` and consult the
fallback before giving up:

```js
  const detected =
    detectTypeLabelFromTitle(title) ?? detectTypeLabelFromCommits(input?.commitMessages);
  if (!detected) {
    return { skip: true, reason: "no-prefix" };
  }
```

Export `detectTypeLabelFromCommits` alongside the existing names.

## Change 2 — MODIFY `.github/workflows/pr-labeler.yml`

Fetch the commits and pass their headlines. Inserted after the live-title
refetch, before `planTypeLabelSync`:

```js
            // Titles that carry no recognisable type (e.g. `stack 3/5: ...`)
            // fall back to the PR's commits, which are conventional even when
            // the title is not.
            const commits = await github.paginate(github.rest.pulls.listCommits, {
              owner, repo, pull_number: pr, per_page: 100,
            });

            const plan = planTypeLabelSync({
              title: liveTitle,
              currentLabels: currentLabels.map((label) => label.name),
              events,
              commitMessages: commits.map((commit) => commit.commit?.message || ""),
            });
```

No permission change: `pulls.listCommits` is covered by the existing
`contents: read`.

## Change 3 — MODIFY `.github/scripts/pr-labeler.test.cjs`

Add a `detectTypeLabelFromCommits` describe block plus `planTypeLabelSync`
cases:

- real stack titles + conventional commits → the commits' type is applied;
- the real #955 shape (four `fix:` + one `test:`) → `bug`, not a skip;
- an all-`chore` PR (`ci:` + `test:`) → `chore`;
- genuinely disagreeing commits (`fix:` + `feat:`) → still skipped;
- no commits and no title prefix → still skipped;
- a recognisable title is NOT overridden by its commits.

## Change 4 — MODIFY `docs-site/src/content/docs/contributing/pr-quality.md`

Document two things contributors currently cannot know:

1. stacked child PRs run the same test CI as `dev`-targeted PRs (post-`010`);
2. the type label comes from the title, falling back to the commits.

And state the promotion caveat: `pr-labeler.yml` and `enforce-pr-target.yml` run
on `pull_request_target`, which GitHub loads from the repository **default
branch**, so a change to either takes effect only after promotion to `main` —
not when it lands on `dev`. `ci.yml` runs on `pull_request` and takes effect as
soon as it is on the targeted base branch.

## Verification

1. `node --test .github/scripts/pr-labeler.test.cjs` — green.
2. Drive red: remove the `?? detectTypeLabelFromCommits(...)` fallback; the new
   cases must fail. Restore.
3. `bun test tests/ci-workflows.test.ts`, `bun run typecheck`,
   `bun run privacy:scan` — green.
4. Live label behavior cannot be proven from `dev`: the labeler is loaded from
   the default branch. Report that honestly rather than claiming live effect.

## Risk

The fallback can only *add* a label where there was none, or leave the skip in
place. It never overrides a title that already classifies, and never overrides a
human's label (the existing `hasHumanTypeLabelOverride` gate runs first).
