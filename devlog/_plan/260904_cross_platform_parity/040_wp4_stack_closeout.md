# 040 - wp4: stack close-out (administrative, NOT a fourth PR)

This unit ships exactly THREE pull requests: wp1, wp2, wp3. wp4 opens no fourth
PR and introduces no code. It is the administrative work performed ON the
existing stack - CI triage, review responses, retargeting, and the closeout
record - and its one artifact, `004_implementation_outcome.md`, is a devlog
commit on the last child branch in the chain.

Evidence: the three PRs from wp1, wp2, wp3.

## What this phase does

1. Confirm each PR in the chain is open against the right base: wp1 on `dev`,
   wp2 on wp1's head, wp3 on wp2's head. `enforce-target` skips the wrong-base
   gate for children of an open PR; after a parent lands, retarget the child to
   `dev`.
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

- Exactly three PRs open or landed against `dev`, each filled from
  `.github/PULL_REQUEST_TEMPLATE.md`. No fourth PR exists.
- CI conclusion captured per PR as goalplan evidence.
- `004` written.
- `050` lists every deliberate follow-up with its reason.
