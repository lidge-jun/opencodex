# 041 - CI triage for the stack

Recorded at wp4. Every failure below was reproduced on clean `origin/dev` before
being called inherited, because "not mine" is a claim that needs evidence rather
than an assumption.

## The rebase that was actually required

The first CI run on #3437 failed `release version line`:

> package.json version 2.42.0 equals release tag v2.42.0, but this commit is not
> the one that tag names. The tree claims an already-published version.

Real, and ours to fix: the stack branched when `dev` was at 2.42.0, v2.42.0 then
shipped, and `dev` moved to 2.43.0. The whole chain was rebased onto current
`dev` and force-pushed with `--force-with-lease`, bottom-up so each child kept
its parent. `tests/release-version-line.test.ts` passes locally afterwards.

## Inherited failures, reproduced on clean dev

Two suites fail on `origin/dev` at `20011a1c4` with no change of ours applied.
Verified in a scratch worktree (`git worktree add .tmp/devcheck origin/dev`),
not inferred:

**`tests/loopback-listener-integration.test.ts:366`** - "admits the exact
standalone Images POST routes so they reach the relay (#3428)". Expects the
status to be 400 or 503, receives 401. Clean dev: 30 pass, 1 fail. Our branch:
identical, 30 pass, 1 fail. The test arrived with #3430
(`fix(server): allow image routes on loopback listener`) and exercises image
routes on the loopback listener, which no file in this stack touches.

**`tests/star-deferral.test.ts:102`** - "agent deferral fires once per version,
never writes the marker, and a human run still prompts". Expects `> 0`, receives
`0`. Clean dev: 6 pass, 1 fail. Same on our branch.

Neither is in this unit's blast radius. The stack changes
`src/lib/windows-user-principal.ts`, `src/oauth/meta-muse.ts`,
`src/providers/registry.ts`, two docs files and three test files.

## Disposition

The version-line failure was ours and is fixed. The other two are open defects on
`dev` that any PR opened today inherits; they are not this stack's to fix, and
fixing them here would smuggle unrelated work into a scoped chain. They should be
raised as their own issues against the units that introduced them.

Worth stating plainly: this means the stack cannot show an all-green CI run until
`dev` is green. The honest report is "no new failures", not "all checks pass".

