# wp5 — the 2.57.0 release

Closed. 2.57.0 is on `main` and `preview`, the GitHub release exists, and `npm publish` returned
success with a signed provenance statement. Registry propagation is tracked at the end.

## Sequence, with evidence

| Step | What happened | Evidence |
| --- | --- | --- |
| Freeze the candidate | `1831193294` on `dev`, `package.json` 2.57.0 | Cross-platform CI push run `35131181996`: success across the full matrix, all six Windows shards included. First green `dev` run since `35091966777`. |
| Move `dev`'s version line first | #4827 opened by `dev-version-bump.yml` run `35127386565`, merged as `3f639dfdad` | CI run `35127440220` success after rerunning a cancelled `macos 1/2`; Service lifecycle `35127440065` success. |
| Promote to `main` | #4829 merged as `44de45dfdc` | Merge commit, matching the 2.56.0 promotion #4694. `enforce-target` red by design. |
| Prove the release SHA | `44de45dfdc` | Cross-platform CI run `35133242171`: success. Service lifecycle run `35133242154`: success. |
| Dispatch `release.yml` | version 2.57.0, tag latest, dry-run false, `expected-sha=44de45dfdc33d30af22502d2bed98014fe16d83b` | Run `35135131119`: success. `Publish` step ends `+ @bitkyc08/opencodex@2.57.0`; provenance in the sigstore transparency log at logIndex 2865732791. GitHub release `v2.57.0` created 18:35:07Z. |
| Promote to `preview` | #4831 merged as `b70f3d7fcb` | `git diff origin/main HEAD` empty; only `package.json`'s version line conflicted and was resolved to `main`'s 2.57.0, the same resolution #4698 used. |

## Two decisions worth recording

**The red `dev` was not a reason to stop.** Five consecutive failing runs looked like a regression
and were not; `010_dev_green.md` has the per-run forensics. The largest class was already fixed by
the candidate's own parent (#4821 pinning Bun back to 1.4.0), and the remaining class was a
45-second spawn budget that a Windows runner beat by 5.7 seconds (#4830). Aside research confirmed
Bun 1.4.2 is still the latest stable and no released version fixes that Windows crash class, so the
1.4.0 pin stays.

**CodeQL's "10 new alerts including 8 high severity" was reviewed rather than waived.** Eight carry
alert numbers already open on `main` and one is the same flow as main's #175 at a shifted line.
Exactly one is new — #183, `js/insufficient-password-hash` at `src/codex/account-label.ts:31` —
and it is a false positive, because that SHA-256 produces a log label for API-key selection, not a
password hash. The reasoning is on #4829.

## Registry propagation

`npm publish` succeeded at 18:34:37Z and npm answered "Your package is being processed and may take
a few minutes to become available." The workflow's own `Post-publish registry smoke` step then read
the registry six times without confirming, recorded `verification=pending`, and said in its summary:
*inspect the registry before announcing availability; do not republish this version.*

It took about eight minutes. `https://registry.npmjs.org/@bitkyc08%2fopencodex/2.57.0` answered 404
through 18:42 and then 200; the packument's `modified` moved to 2026-09-16T18:42:50.857Z and
`dist-tags.latest` reads 2.57.0. `npm view @bitkyc08/opencodex version` agrees.

The step is doing its job and its bounded read window is simply shorter than npm's worst-case
processing time. Nothing needs changing: the warning is accurate, it does not fail the release, and
it tells the reader exactly what to do instead of republishing. A pending verification here means
wait and re-read, not cut another version.
