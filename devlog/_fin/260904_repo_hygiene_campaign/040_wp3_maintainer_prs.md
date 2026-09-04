# 040 — wp3: maintainer-authored PR drawdown

Ten of the 53 open pull requests are authored by `lidge-jun`. These carry no
contributor-credit obligation, so they are classified first and act as a
rehearsal for the evidence format used on contributor PRs.

Classification per PR:

- **SUPERSEDED** — every file the PR touches is already identical on `dev`
  (T3 applied to the PR head). Close with a comment naming the landing commit.
- **PARTIAL** — some paths landed, some did not. Close and carry the remainder
  into a consolidated follow-up issue.
- **LIVE** — keep open.

Evidence recorded per PR: head SHA, files touched, files still differing from
`dev`, and the commit or PR that landed the overlap.

## Exit criteria

Every maintainer PR has a verdict with captured evidence, and each SUPERSEDED or
PARTIAL one is closed with a comment a reader can independently check.
