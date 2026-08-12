# 000 — devlog publication feasibility: plan and STOP

Status: **EXECUTED on local `dev`. Nothing pushed.** WP1–WP4 all closed; the conversion
landed as `2435b1149`, with `f6ce1d5bd` and `bc2f9502e` as the two follow-ups the privacy
gate demanded once devlog came into scope. Execution evidence is in `030`.

The first pass stopped at WP2 with a NEEDS_HUMAN on two security documents. The user asked
why they could not simply be moved to scratch, and answering that question overturned the
verdict: those two documents describe fixes that are already on public `main`, so they were
never blockers. The real blockers are two different units, and `003` records both the
correction and the excision decision.

`.gitmodules` is gone, `.gitignore` carries path rules instead of a blanket `devlog/`, and
the gitlink is replaced by 1618 ordinary blobs.

## What was asked

Convert devlog from a private submodule into ordinary tracked files in the PUBLIC
opencodex repository, defended by review rules instead of repository privacy
(user decision: option A-prime), document it, and land it on local `dev`.

## Why the loop stopped instead of converting

The plan put a publication scan (WP2) BEFORE the conversion (WP3) precisely so that a
blocker would surface while it was still reversible. It surfaced.

Two tracked documents describe an account-boundary security failure and its patch plan
in operational detail, with no in-document evidence that the finding was ever publicly
disclosed:

- `_fin/280_codex-multi-auth-security-patch-plan/00_patch_plan.md`
- `_fin/145_common-security-hardening/00_plan.md`

Both are `git ls-files`-tracked, so a conversion would publish them. `_fin` is an
archival label meaning "unit closed", not "finding disclosed".

Publishing these is a disclosure decision about this project's own security posture. It
is not a judgment an agent should make unilaterally, and it is irreversible once pushed.
The goal's own acceptance criteria named this exact case as `NEEDS_HUMAN`.

## Corrected framing (supersedes my earlier assessment)

In the conversation preceding this loop I said the private-repo rationale was "mostly
not holding up" based on a keyword sweep: no real credentials, CVE mentions already
public, no embargo markers. That sweep was too shallow to support the conclusion.

What a proper scan found:

| Axis | Earlier read | Verified |
|---|---|---|
| Credentials | 1 sentinel hit, benign | Confirmed benign: 16 fixed-format hits, all sentinels/placeholders/examples |
| Embargoed security material | "none" | **2 tracked units with undisclosed account-boundary failure detail** |
| Personal / operational data | not examined | 109 email matches, 1174 absolute home paths, 15 private repo URLs |
| Infrastructure state | 55 ToS / 128 detection hits, judged acceptable | 1650 endpoint refs, 426 account-pool refs, 571 identifiers, 1517 rate-limit refs, 467 detection refs |

The credential conclusion held. The security-material conclusion did not, and it is the
one that governs.

## What the conversion would still need

Publishing remains possible, but not as a bulk `git add`. It needs a curation pass:

1. A disclosure decision on the two `(iii)` units — excise, redact, or accept publication.
2. Sanitization of personal data: absolute home paths carrying a username, real email
   addresses, private repository URLs.
3. A decision on infrastructure-state material (account-pool architecture, detection
   reasoning) — the very category the current devlog README says must stay out of a
   public tree.
4. `privacy-scan.ts` coverage: `devlog/` sits in `EXCLUDED_PREFIXES`, so publishing it
   adds ZERO scan coverage until that entry is removed. Removing it before sanitization
   would turn CI red.
5. `tests/repo-hygiene.test.ts` rewrite: it asserts devlog is the only gitlink with no
   tracked files, so it fails the moment the conversion lands.

## Work-phase map (final)

| WP | Doc | Slice | Status |
|----|-----|-------|--------|
| 1 | `001`, `002` | Research: reference inventory + publication scan definition | done |
| 2 | `003`, `004` | Publication scan, then re-adjudication that overturned the stop | done |
| 3 | `010`, `030` | Conversion (gitlink removal, tracking, un-ignore, scan coverage) | done |
| 4 | `020`, `030` | Rule enforcement + hygiene tripwire | done |

The first version of this table recorded WP2 as `STOPPED — NEEDS_HUMAN`. That verdict was
overturned in `003`, not waived: the two documents it flagged describe fixes that are
already ancestors of public `main`.

## The good news, unchanged

The pointer-churn diagnosis that motivated this work is still correct and still worth
fixing: 1723 devlog-path commits, and `dev`/`preview`/`main` each hold a different
gitlink. Option A from the earlier discussion — drop the submodule relationship and keep
devlog as a local private repo — removes that churn WITHOUT any publication decision.
It remains available and needs no security clearance.

---

# Roadmap (amended after the `003` re-adjudication)

| WP | Doc | Slice | Depends on | Closes with |
|----|-----|-------|------------|-------------|
| 1 | `001`, `002` | Research: reference inventory + publication scan | — | done, committed |
| 2 | `003` | Re-adjudicate the scan: verify resolution against `main` ancestry | WP1 | done — blockers reduced from "2 security plans" to "2 live-triage units" |
| 3 | `010` | Excise the 2 live-triage units, then convert (drop gitlink, un-ignore, track, restore privacy-scan coverage, rewrite hygiene test) | WP2 | 10 criteria incl. temp-clone readability and a green privacy:scan with devlog no longer excluded |
| 4 | `020` | Rule enforcement: correct the now-false submodule docs, state the maintainer-binding rule, add the tripwire test | WP3 | 8 criteria incl. driving the tripwire red once |

WP3 is the irreversible phase. WP4 must not be deferred past it: the moment devlog is
public, the enforcement gap that produced the excised units is live.

## Corrections this unit records against itself

Kept deliberately, because the same mistakes are easy to repeat:

1. **`002` scanned the working tree, not the index.** That pulled in gitignored third-party
   vendored source (`_chase/_litellm` at 129 MB) and inflated the size figure to 178 MB /
   9974 files. The real publication set is 1620 tracked files / 36 MB, about 5 percent on
   top of an already-711 MB public `.git`.
2. **`002` read a document's own alarm language as its current status.** The 280 patch plan
   says `Main merge: NO-GO`, which described June. Its sibling manifest attributes all five
   failures to specific commits, and all six are ancestors of public `main`.
3. **`002` counted any email or home path as PII.** 1160 of 1164 home paths are the
   maintainer's own username; the flagged emails are already commit authors on public
   `main`. Neither needs sanitization.

The corrected scan rule: scope to `git ls-files`, verify resolution against `main`
ancestry, and ask whether publishing reveals something a public diff does not.
