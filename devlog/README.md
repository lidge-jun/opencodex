# devlog

Planning and investigation notes for
[lidge-jun/opencodex](https://github.com/lidge-jun/opencodex), tracked in that
repository. Public.

## Why these are public

These notes were a private submodule until the bookkeeping outgrew the benefit:
1723 commits touched the gitlink, and `dev`, `preview`, and `main` each held a
different pointer, so every branch move and promotion dragged a diff. The
privacy was doing one job — keeping pre-disclosure security material out of
public view — and that job is now done by a rule plus a check instead, which is
cheaper and does not tax every ordinary commit.

What that trade requires is stated below and is not optional.

## What belongs here

Closed records: plans, audits, measurements, and post-mortems for work that has
shipped. A `_fin/` unit documents something already visible in public git
history, so publishing the writeup discloses nothing the diff does not.

## Layout

- `_plan/` — units still open. One directory per unit, decade-numbered docs.
- `_fin/` — closed units. A unit moves here once its terminal outcome is
  recorded (`DONE`, `NOOP`, `BLOCKED`, or `NEEDS_HUMAN` with the reason).
- `_chase/` — external reference material captured for parity comparisons.

## Security working notes do not live here

**Never commit unreleased security findings, draft advisories, exploit paths, or
pre-disclosure patch plans here.** This directory is public, so a commit is a
disclosure the moment it is pushed, and the history is impractical to purge. A
private repository is no better: it is cloned across machines and CI and
outlives the embargo.

**This binds maintainers.** It has been violated by maintainer-authored triage
before — two units of open security review accumulated under `_plan/` and had to
be excised before this directory could be published.

The deciding question before writing a security note here: **is there already a
public diff that reveals this weakness?** If yes, it is a closed record and
belongs in `_fin/`. If no, it is pre-disclosure material and belongs in scratch.

Security work happens in an untracked scratch directory (`.tmp/` in the public
working tree, or a `mktemp -d` path), and only the published outcome — release
notes, advisory text, the fix itself — reaches any repository. See the
"Security working notes" section of the public [`AGENTS.md`](https://github.com/lidge-jun/opencodex/blob/dev/AGENTS.md)
for the full rule.

## Submodule hygiene

The public repository pins this repository by commit and declares
`ignore = dirty`, `update = none`, `shallow = true`. Public CI never checks it
out and nothing in the build or test path reads from it, so an unavailable or
stale pointer cannot fail a public check. Do not add embedded git repositories
here; a nested `.git` becomes a `160000` gitlink in the parent index and breaks
`actions/checkout` for everyone.
