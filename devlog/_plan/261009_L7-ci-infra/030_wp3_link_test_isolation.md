# 030 — wp3: #6726 link-test isolation

PR title: `test(link): isolate the remote-prelude tests from a host-installed ocx`
Branch `codex/l7-link-test-isolation`, worktree `.tmp/lanes/L7-ci-infra-3`.
Credit: `Co-authored-by` Sungyong Cho (commit identity from the source PR).

The PR is already correct (head `8ebf15ec3f`, merges cleanly, no review findings). Only
its intake checks ran because fork CI needs maintainer approval. The carry exists to get
hosted CI on an origin branch.

## Change (tests/clients/link-ssh-argv.test.ts only)

- import `symlinkSync`; doc comment on `fakeOcx`;
- new `shOnlyRemotePath(home)` that creates `home/remote-bin/sh -> /bin/sh`;
- the two tests that expect the `~/.bun/bin` stub use that PATH instead of
  `/usr/bin:/bin`; the first test's expected PATH line starts with it.

Recipe: `git cherry-pick dc3785d1bc 8ebf15ec3f` onto `origin/dev`, amend the last commit
message with the trailer.

## Acceptance

- Focused: `bun test tests/clients/link-ssh-argv.test.ts` (this Mac has broken `ocx` shims
  on PATH, so it is a meaningful host). Regression guard from the PR: prepending the
  fallbacks in `REMOTE_OCX_SCRIPT` must make three tests fail.
- Hosted: exact-head CI green.
