# 002 — A-phase audit round 2: verdict and fold-back

Round 2 re-audited the round-1 fold-back plus the new security gate.
**VERDICT: FAIL**, 3 new High blockers. All three were verified and corrected;
none rebutted. Two of them were errors I introduced *while fixing round 1*.

## Blocker 1 (High) — I put undisclosed security findings in the public devlog

The first `012_security_review.md` recorded severities, exact vulnerable paths,
trust-boundary mechanics, the persistence flow, and example payloads for two
**unfixed** findings. `AGENTS.md:59` requires that material to stay in scratch;
`AGENTS.md:67` explicitly forbids `devlog/`. Pointing at a scratch copy does not
sanitize a public copy.

This is the violation `AGENTS.md` warns about by name — it notes the rule was
broken by maintainer-authored triage before and that seniority is not an
exemption. Neither is being the agent that wrote the gate.

**Corrected.** The file was deleted from the tree (nothing had been committed),
the full text moved to scratch alongside the finding notes, and replaced with
`012_security_gate_record.md`: RC, reviewer scope, verdict, opaque finding IDs,
ship/no-ship disposition, and the owner decision packet — no mechanism.

## Blocker 2 (High) — the baseline correction was still incomplete

I corrected the *command* baseline but left the delta *statistics* from the old
range. Verified numbers:

| Claim in round 1 | Truth |
|------------------|-------|
| 195 files, +15,552 / -483 | **373 files, +33,933 / -1,417** (`121f1ad92..RC`) |
| 35 first-parent merges | **48** (`2418291eb..RC`) |
| **zero** non-merge commits | **44** first-parent non-merges |
| "every change arrived through a reviewed pull request" | false |

The provenance claim was the damaging one: it told a reader that nothing
reached `dev` outside review, which the security gate then partially relied on.
The 44 direct commits are maintainer integration work — permitted by
`MAINTAINERS.md`, but not the same thing as PR-reviewed.

Also surfaced by the correct baseline: `bin/ocx.mjs` (shipped in the tarball)
and `gui/package.json`'s executable `npx --yes react-doctor` pin (0.9.3 →
0.9.11), neither visible under the old range. Confirmed clean: no root
dependency change, no `bun.lock`, no `.npmrc`, no postinstall or packaging hook.

**Corrected** in `000_plan.md` with both measurements and an explicit
retraction.

## Blocker 3 (High) — SEC-02 does reach users; I said it did not

I wrote that neither RC-specific finding reaches the npm artifact. True for
SEC-01, false for SEC-02:

```
$ node -p "JSON.stringify(require('./package.json').files)"
["bin","src","gui/dist","assets/…","README.md","AGENTS_INSTALL.md","LICENSE"]
$ grep -n "^\.github" .npmignore
6:.github/
```

`src` ships whole; `.npmignore` excludes `.github/` but not `src`; and
`scripts/prepare-package.ts` only normalizes permissions. The Lab code carrying
SEC-02 is under `src/lab/`, so it is published runtime code.

This mattered: it was the load-bearing sentence in my "safe to ship anyway"
reasoning. **Corrected** — the gate record now states SEC-02 reaches users, and
any risk acceptance must name that.

## What round 2 confirmed as correct

- **SEC-03 is pre-existing.** The file carrying it resolves to the same blob at
  the v2.11.1 tag and the RC; `git diff --exit-code` succeeds; the path log is
  empty. #1369 narrows malformed local imports and does not worsen it. The path
  is withheld because SEC-03 is still unfixed.
- **SEC-01's artifact bound holds.** `.npmignore:6` excludes `.github/` and
  `prepare-package.ts` copies nothing from it.
- **The omission risk acceptance is sound.** No open issue names #1398, #1396,
  or their symptoms. #1010 declares `Closes #1009`, but #1009 is already closed
  and was a feature request.
- **Sibling promotion is valid.** It complies with `MAINTAINERS.md:22`; the
  previous train's chained `commit-tree` merge was an exception forced by a
  regressed `main` tree, not a precedent. Both merge-tree dry runs are clean.
- **Release notes and ancestry are safe.** `release.yml` reads the full tag
  set, detects the preview tag is not an ancestor, retains the stable baseline,
  and `scripts/release-notes.ts:448` deduplicates repeated PR numbers.
  `enforce-target` is PR-event machinery and does not gate a maintainer-driven
  promotion.

## On the BLOCKED conclusion

I asked the reviewer to argue the opposite case. Its strongest version: SEC-01
is already live on `dev` and excluded from npm, so releasing changes nothing
about it; SEC-02 is bounded, opt-in, length-limited, and already filters
obvious secrets and filesystem paths; the RC is green and deploy was
authorized. A maintainer could reasonably accept that and ship.

Its actual position, which I share: generic deploy authorization predates the
discovery of both findings and cannot retroactively cover them. Continuation
needs either fixes plus re-review, or an explicit informed acceptance that
names SEC-02 as user-reaching — not the inaccurate "neither reaches npm"
framing I originally offered.

## Disposition

3 blockers folded, 0 rebutted. The plan is now accurate. The release remains
**BLOCKED on an owner decision**, which is a authorization boundary rather
than a mechanical failure: every CI gate, local suite, and merge dry-run is
green.
