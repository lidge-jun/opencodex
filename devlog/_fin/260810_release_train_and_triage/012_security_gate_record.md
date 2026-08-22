# 012 — WP1 gate: security review record

`AGENTS.md` requires explicit security review for changes touching
authentication, credential handling, OAuth, workflows, or release automation.
Round-1 audit blocker 4 established that several credential-boundary PRs in
this delta carried no `APPROVED` review. This file is the **gate record** for
the review that requirement demands.

## Why this file contains no technical detail

`AGENTS.md` §"Security working notes" is explicit: unreleased findings,
severity assessments, bypass reasoning, and reproduction steps go to scratch
space, never to `devlog/` — because `devlog/` is public and pushing it
discloses the finding. The test it gives is *"is there already a public diff
that reveals this weakness?"* For the open findings below the answer is no, so
the detail lives in scratch and only the gate outcome is recorded here.

The first version of this file failed that test. It named severities, exact
vulnerable paths, the trust-boundary mechanics, the persistence flow, and
example payloads for two unfixed findings. It was caught by the round-2 audit
before anything was committed, replaced with this record, and the full text was
moved to scratch. Worth stating plainly: the rule binds this agent exactly as
`AGENTS.md` says it binds maintainers, and writing the detail here was a
violation, not a judgment call.

## Gate outcome

| Field | Value |
|-------|-------|
| Reviewed commit | `dc4dd45b04b2564a207b72f9c761a93e631b5299` |
| Reviewer | independent non-author agent, adversarial, read-only |
| Scope | credential/auth surface in `121f1ad92..RC` — CL-03 live lease, Claude credential routing, proxy admission token, OAuth expiry adoption, Codex account normalization, quota cooldown |
| Verdict | **`SECURITY VERDICT: BLOCK (critical=1)`** |
| Findings | SEC-01 (Critical), SEC-02 (High), SEC-03 (High), SEC-04 (Low) |
| Detail location | scratch only — not in any tracked directory |

## Re-review after remediation — gate CLEARED

The owner chose "fix first, then release". SEC-01 and SEC-02 were remediated and
the tree went back through review.

| Field | Value |
|-------|-------|
| Reviewed commit | `76c544c65` (merged with `origin/dev` at `0de4fd2d7`) |
| Reviewers | three independent non-author agents across 8 re-review rounds |
| Defects found | **35**, every one reproduced locally before being fixed |
| Final verdict | **`READY TO SHIP`** |
| Residual findings | 2 Low, both non-blocking and both now disclosed in `structure/09_compatibility-lab.md` |

### The reviewed tree is the released tree

The RC published by this train is `9c051342d`, one commit past the reviewed
`76c544c65`. That gap is **this file** and nothing else:

```
$ git diff --name-only 76c544c65 9c051342d
devlog/_fin/260810_release_train_and_triage/012_security_gate_record.md
```

So the reviewed source tree and the shipped source tree are byte-identical; the
only change is the record you are reading. `0de4fd2d7` (the `origin/dev` head at
review time) is a genuine ancestor of both, merged in at `01a29ab6d` —
`git merge-base --is-ancestor 0de4fd2d7 76c544c65` exits 0. A later audit read
that line as claiming a merge that never happened; the ancestry check above is
the disproof.

The final reviewer verified the shipped limits table against the code and found
it accurate: every disclosed residual behaves as documented, and nothing the
table claims to cover failed. Performance is linear to 400 KB. Three regression
assertions were mutation-checked and each fails when its production rule is
removed.

### Disposition by finding

| ID | Status |
|----|--------|
| SEC-01 | **CLOSED** — privileged workflows source trusted scripts from an integration-branch allowlist; guards ablation-verified against five distinct evasion shapes |
| SEC-02 | **CLOSED** — both evidence sinks sanitized on both constructors, 29 regression tests, limits documented |
| SEC-03 | unchanged — pre-existing at v2.11.1, byte-identical, out of scope for this train |
| SEC-04 | unchanged — accepted Low |

### What the loop cost, and what it bought

Eight rounds is a lot, and the record should say plainly why. Two mistakes
repeated across them:

- **Enumerating instead of ruling.** Delimiters grew `/` → `?#&=` → `:` → `;`;
  the workflow denylist lost five times to `refs/pull`, `format()`,
  `repository:`, `gh pr checkout`, and `git clone`. Both were only settled by
  stating the invariant instead of listing the exceptions.
- **Fixing half a symmetry.** Case-insensitivity applied to an id suffix but not
  its label; underscore boundaries fixed for IPv4 but not MAC.

The most valuable findings were not leaks. `ETIMEDOUT after 30 seconds` became
`ETIMEDOUT [host] 30 seconds` — destroying the diagnostic while concealing
nothing — and a widened hostname rule was eating `provider.metric.p95`. A
sanitizer that removes too much fails this contract exactly as a leak does, and
the suite now asserts both directions.

Reviewer verification on the RC: `bun run privacy:scan` passed,
`bun run typecheck` passed, focused security tests 449 pass / 0 fail, full
suite 10,526 pass / 7 skip / 0 fail.

## Disposition by finding, stated without mechanism

| ID | Introduced by this delta? | Reaches the npm artifact? | Blocks the release? |
|----|---------------------------|---------------------------|---------------------|
| SEC-01 | yes | **no** — repository automation only | no longer — **CLOSED**, see re-review above |
| SEC-02 | yes | **yes** — shipped runtime code | no longer — **CLOSED**, see re-review above |
| SEC-03 | **no** — pre-existing, byte-identical at v2.11.1 | yes (unchanged) | no |
| SEC-04 | yes | yes | no — hardening item |

> The two "blocks the release" cells above read `yes, pending owner decision`
> until the remediation landed. They are settled now: the owner chose option 1
> and both findings are CLOSED. The historical BLOCK verdict earlier in this
> file is kept as a record of what the gate caught, not as the current state.

SEC-03's classification was independently re-verified: the file carrying it
resolves to the same blob at the v2.11.1 tag and at the RC, `git diff
--exit-code` succeeds, and the path log over the delta is empty. It is a
pre-existing defect surfaced by neighbouring work, not a regression this
release introduces. SEC-03 is **unfixed**, so its location is deliberately not
named here — naming the file for an open finding is the same disclosure the
rest of this record avoids.

## Correction: SEC-02 does reach users

The first disposition claimed neither RC-specific finding reached the npm
artifact. That was wrong for SEC-02 and the round-2 audit caught it.
`package.json` `files` ships the **entire `src` directory**, `.npmignore`
excludes `.github/` but not `src`, and `scripts/prepare-package.ts` only
normalizes permissions. So:

- **SEC-01** — genuinely excluded from the tarball (`.npmignore:6`), already
  active on `dev`, affects repository automation.
- **SEC-02** — shipped runtime code, newly introduced by this release, on an
  opt-in path. It is an end-user risk and must be named as one in any risk
  acceptance.

## Owner decision packet — RESOLVED: option 1, fix first

The release did not proceed on the BLOCK verdict. The owner was given these
three options and **chose option 1**; the remediation and re-review are recorded
in the "gate CLEARED" section above, and the train resumed from there.

1. **Fix first** — remediate SEC-01 and SEC-02, re-run the security review
   against the new RC, then run the train. Safest; costs a fix cycle.
2. **Informed acceptance** — accept both risks explicitly, in writing, naming
   that SEC-02 ships to users and can write provider-controlled content into
   durable local evidence on an opt-in path, and that SEC-01 remains live in
   repository automation either way. Then run the train and schedule the fixes.
3. **Partial** — fix SEC-02 (the shipped one) only, ship, and handle SEC-01 on
   the automation track since releasing changes nothing about it.

Generic deploy authorization does not cover this: it was given before either
finding existed. That is the whole reason the gate was added.

The owner's answer was recorded in-session on 2026-08-10: *"고치고 배포 — 두 발견
수정 후 재리뷰"*, i.e. option 1. WP4/WP5 implemented the fixes, WP6 obtained the
non-BLOCK re-review, and WP7 executed the release on the remediated tree.
