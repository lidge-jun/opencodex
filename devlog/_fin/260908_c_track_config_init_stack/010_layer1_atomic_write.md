# 010_layer1_atomic_write.md — wp1: carry PR #3900

Source: [PR #3900](https://github.com/lidge-jun/opencodex/pull/3900) by @x3M3x,
head `744eb644028492784446fe9f0f73813d5d1fe59f`, two commits
(`52c749561`, `744eb6440`).

Branch: `codex/c-track-atomic-write`, base `dev`.

## Problem

`src/config/atomic-write.ts` builds its exclusive-create flags numerically.
Bun on Windows misreads that combination and drops the creation bit, so every
private temp write fails with `ENOENT`: `ocx start`, management-API config
saves, and OAuth credential refreshes all route through these two writers.

## Change (MODIFY, carried unmodified from #3900)

`src/config/atomic-write.ts`

```diff
-  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
+  const descriptor = openSync(path, "wx", 0o600);
```

Applied in both `writePrivateTempFile` and `writePrivateTempFileAsync`; the now
unused `constants` import is dropped.

`tests/windows/windows-secret-acl.test.ts` gains the source-oracle guard
"atomic secret temp writer portability", asserting exactly two portable calls.

## Semantics note (audit correction)

The PR description calls `"wx"` exactly `O_WRONLY | O_CREAT | O_EXCL`. Node and
Bun actually map it to `O_WRONLY | O_CREAT | O_EXCL | O_TRUNC`. It is
**behaviorally** equivalent here rather than bit-identical: exclusive creation
rejects an existing path, so `O_TRUNC` can never truncate one. `0o600` remains
a separate mode argument and still applies. Recorded so a later reader does not
inherit the imprecise claim.

## Security review (independent, read-only)

No blocking finding. Exclusivity is preserved for every caller of the default
wrappers, which include OAuth `auth.json`, Codex account credentials, service
API tokens, `config.json`, and `ocx.pid`. Ownership is marked only after a
successful create, so no new pre-existing-temp or symlink-following path opens.
Windows ACL ordering (create → own → harden → identity check → write → close)
is untouched.

## Authorship

Both commits are cherry-picked with `-x`, so each retains
`x3M3x <amroeid1999@gmail.com>` as its git author and records the source SHA:

| Carried commit | Source commit |
|---|---|
| `6a0abcf90` fix: use portable exclusive config temp creation | `52c7495618f18f2847b7f9468421442c1c573da1` |
| `24a078d80` test: guard atomic temp writes against Bun/Windows ENOENT | `744eb644028492784446fe9f0f73813d5d1fe59f` |

A squash landing keeps only the squash message and drops per-commit authors, so
`b1a7f111c` adds the `Co-authored-by: x3M3x <amroeid1999@gmail.com>` trailer to
the branch. That trailer must be carried into the tip PR squash message and
re-read on the landed commit.

## Verification

An independent read-only audit of the built branch confirmed the carried
source-and-test diff is byte-identical to #3900 pinned patch (2,176 bytes),
that both `-x` annotations and the original author survive, that the trailer
parses through `git interpret-trailers`, and that no other `src/` file changed.

Repository CI on the stack tip only. Local suite, typecheck, and build:
**NOT RUN** (owner instruction).
