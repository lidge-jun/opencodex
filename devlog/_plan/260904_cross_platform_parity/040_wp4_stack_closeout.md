# 040 - wp4: stack close-out (administrative, opens no PR of its own)

This unit ships FOUR pull requests: the wp0 roadmap plus wp1, wp2 and wp3. wp4 opens no further
PR and introduces no code. It is the administrative work performed ON the
existing stack - CI triage, review responses, retargeting, and the closeout
record - and its one artifact, `004_implementation_outcome.md`, is a devlog
commit on the last child branch in the chain.

Evidence: #3436, #3437, #3440 and #3438.

## What this phase does

1. Confirm each PR is open against the right base. The chain is NOT linear:
   #3436 on `dev`, #3437 on #3436, then #3440 and #3438 BOTH on #3437 as
   siblings. wp2 and wp3 share no files, so chaining them would have made one
   wait on the other for nothing. `enforce-target` skips the wrong-base gate
   for children of an open PR; retarget each child to `dev` once its parent
   lands.
2. Read CI on each PR. Triage any failure and fix it in the owning PR rather than
   the tip of the stack, so each commit stays independently reviewable.
3. Answer Codex and CodeRabbit review findings on every PR in the chain.
4. Record the outcome in `004_implementation_outcome.md`: what landed, what review
   changed, what the plan got wrong. This is a devlog-only commit on the last
   child branch, never a new PR.
5. Confirm `docs-site/` matches shipped behavior. wp2 adds the platform-support
   page; wp1 changes the meta-muse refusal wording. English source only, and no
   claim may contradict
   `docs-site/src/content/docs/reference/configuration/providers.md`.

## Verification stance

The user forbade running the full local suite, so CI is the verification
authority for this unit. Each phase names its focused test file; the suite-wide
answer comes from the GitHub Actions run on the PR. A phase may not claim a green
suite from memory or from a local run that did not happen.

## Definition of done

- Four PRs open or landed, each filled from
  `.github/PULL_REQUEST_TEMPLATE.md`. No fourth PR exists.
- CI conclusion captured per PR as goalplan evidence, with any failure either
  fixed here or PROVEN inherited by reproducing it on clean `origin/dev`.
  "Unrelated" is a claim that needs evidence.
- `004` written.
- `050` lists every deliberate follow-up with its reason.
