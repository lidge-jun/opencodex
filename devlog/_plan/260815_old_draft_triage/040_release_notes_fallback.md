# 040 - Release-notes fallback and the v2.20.0 release

## The defect

Release bodies for v2.18.2 and v2.19.0 were 169-character stubs: the npm line
plus a compare link, no changelog. Root cause is not the workflow but its input:
`releases/generate-notes` aggregates MERGED PULL REQUESTS over the compared tag
range. Work had been landing as direct commits on dev, so those ranges had
almost nothing the API would count.

Measured live before the fix:

| Range | Commits | PR-associated | Body |
|-------|---------|---------------|------|
| v2.14.2..v2.16.0 | 62 | 52 (84%) | 1883 chars |
| v2.16.0..v2.17.0 | 31 | 7 (23%) | 523 chars |
| v2.17.0..v2.18.2 | 36 | 0 | 169 (stub) |
| v2.18.2..v2.19.0 | 21 | 2 | 169 (stub) |

The two PR-associated commits in the v2.19.0 range did not help either: one was
the release merge commit, and the other belonged to a PR based on `dev`, which
a main-tag comparison does not count.

## The fix (#1766, dev c71c82749)

When the PR delta yields no categories, the workflow renders the commit log
instead - categorized by conventional-commit prefix, excluding merge and
release-bump commits. Replaying the real v2.18.2..v2.19.0 range turns the stub
into a 1.8 KB categorized changelog.

Three adversarial review rounds produced seven blockers, all folded:

- Commit log is NUL-framed (`git log -z`). U+001F is legal in both commit
  subjects AND git author names, so the original unit-separator framing could be
  forged from either side; git forbids NUL in commit content.
- `%an` is a free-form display name, not a GitHub login. A contributor named
  "Abhishek Sharma" rendered as a live `@Abhishek` mention. Authors now render as
  plain text in a `(sha, Name)` trailer.
- Markdown metacharacters are backslash-escaped, not deleted, so technical text
  like `Map<K, V> | CLI` survives while staying inert.
- Fallback generation depends on this range's PR delta only. Gating on carried
  notes too silently dropped every post-preview direct commit.
- Carried commit bullets survive the preview-to-stable carry, and carried plus
  current sections merge by category so a shared heading is not emitted twice.
- `merge:` conventional-prefix commits join the plumbing filter.
- Two converted tests were vacuous (literal `\u001f` fixtures parsed to nothing).

16 regression tests; focused suite 70/70.

## The release

- dev c71c82749 -> main 1cf216299 (direct push) and -> preview via PR #1768
  (preview is ruleset-protected like dev, so the direct push was rejected).
- `scripts/release.ts 2.20.0 --publish`: preflight 12374 pass / 0 fail, bumped
  package.json, pushed release commit 8ea6c0851, waited on exact-SHA CI.
- First exact-SHA CI attempt failed on a macOS Bun runtime segfault (exit 133,
  RSS 3.27GB on a 7.52GB runner, zero assertion failures). Rerun passed. Worth
  watching as a memory-pressure signal; it is not a code defect.
- Release workflow run 31886119548 succeeded with expected-sha pinning.

Verified: npm dist-tag `latest` = 2.20.0; tag v2.20.0 = 8ea6c0851; GitHub
Release targets that SHA; body is 4173 chars with real categories.

Note: the fallback did NOT fire on this release. This range carried real PR
merges (#1736, #1744, #1752 and others), so generate-notes produced categories
on its own and the guard correctly left the fallback unused. Its correctness
rests on the reproduced v2.18.2..v2.19.0 replay and the regression suite.
