# 050 — WP6: release gates on dev + go/no-go note

> **EXECUTION AUTHORITY: `cursor-call-integration.zsh release_gates`.**
> The commands below are the reasoning, not the runbook. Seven audit rounds proved a
> markdown file cannot enforce that a variable is bound before it is read (`019`), so
> the script owns what runs and this doc owns why. If they disagree the script is
> right and this doc is stale — fix the doc.

Revised by audit `r1` F5 (these are a RE-RUN, not first contact — first contact is
`020`, before the PRs) and audit `r3` F2/F4/F5.

## Scope boundary (explicit)

IN: re-running the gates on merged `dev` and writing an evidence-backed readiness
note.

OUT unless the user says otherwise: `npm publish`, any version bump, `main`
promotion, tag creation. `scripts/release.ts` is the release authority and the
repository's OIDC workflow is the only publish mechanism — never a direct
`npm publish`.

## Gates (dedicated worktree, r3 F2)

`MERGED_DEV` is inherited from `040` — the OID of PR3's merge commit, not a fresh
read. Build the worktree at it and assert what landed there:

    DEVDIR=/tmp/ocx-dev-${MERGED_DEV:0:9}
    ssh lidge "cd ~/Developer/opencodex && git fetch origin dev && git worktree add $DEVDIR $MERGED_DEV"
    ssh lidge "cd $DEVDIR && test \"\$(git rev-parse HEAD)\" = \"$MERGED_DEV\" && bun install --frozen-lockfile"
    ssh lidge "cd $DEVDIR && bun x tsc --noEmit"
    ssh lidge "cd $DEVDIR && bun run privacy:scan"
    ssh lidge "cd $DEVDIR && bun run audit:high"
    ssh lidge "cd $DEVDIR && bun run build:gui"
    ssh lidge "cd $DEVDIR && bun test --isolate tests"

`MERGED_DEV` is the SHA `dev` carried when PR3 landed, taken from the merge commit
itself in `040` and already proven to descend from `VERIFIED_TIP`. Do not
substitute a fresh read of `origin/dev`: if someone else pushed in between, these
gates would describe a tree this campaign never produced, and a green result would be
attributed to work that is not ours (audit `r13` sweep).

Never `checkout -f` the shared `~/Developer/opencodex`. Remove the worktree when
done.

`build:gui` is NOT optional for a readiness claim even though no `gui/` path
changed: `prepublishOnly` (`package.json:49`) runs `audit:high`, `typecheck`, and
`build:gui` on every publish, and `build:gui` also runs `prepare:package`
(`package.json:46-47`). `lint:gui` stays N/A with its evidence
(`git diff --name-only` showing no `gui/` paths).

## Docs-site determination (must already be made at `030`)

- Cursor tool-result images: the encoder supports them, production strips them
  upstream (`005` F1). **Do not document a capability that does not reach the
  provider.** If `docs-site/` says the Cursor adapter cannot send images, that text
  is still accurate end-to-end and stays.
- Truncated-turn reporting (`failed` instead of `completed`) is a correctness fix in
  a failure path, not a documented feature. No docs change.

Record the determination and its reasoning; a bare "no docs needed" is not evidence.

## Live refs, read at write time (r3 F5)

Do not copy a ref from this plan into the note. Re-read them, using the live-remote
discipline of `scripts/release.ts:327-335`:

```
git ls-remote origin refs/heads/main refs/heads/dev
git ls-remote --tags origin | tail -5
npm view @bitkyc08/opencodex dist-tags
gh release list --limit 3
```

Known drift already observed: `main` was `474584bcd` when the campaign started,
then `0013b2347`, and the plan's own draft was stale within the hour. `v2.24.2` the
TAG still points at `474584bcd`, which is a different thing from the `main` tip —
state both, do not conflate them.

## Go/no-go note

Write `060_release_readiness.md` with:

- every gate, its command, its output, and the SHA it ran against;
- the governance position from `040` verbatim: gates green on Linux, CI waived by
  the owner, each merge an owner-authorized exception;
- **what publication would still require even after a go decision**: the release
  authority waits for a successful Cross-platform CI run AND a successful Service
  lifecycle run at the exact release SHA (`scripts/release.ts:393-401`). A readiness
  note that omits this implies publishing is one command away when it is not;
- the open follow-ups from `000` a reader would otherwise assume were fixed —
  especially F1, since the campaign's own docs previously overstated it;
- whether `dev` is releasable as-is;
- an explicit recommendation on cutting a version, with the reason, against the
  freshly-read version state. A provider-correctness batch of this size is a
  minor-bump candidate, but the decision is the maintainer's — state the
  recommendation, do not act on it.

## Verification (C)

All gate commands exit 0 at a named `dev` SHA, the live refs in the note match a
`git ls-remote` run recorded alongside them, and the note is committed.
