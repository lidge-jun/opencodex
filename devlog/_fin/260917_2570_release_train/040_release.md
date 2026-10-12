# wp5 — the 2.57.0 release

Closed. 2.57.0 is on `main` and `preview`, the GitHub release exists, and `npm publish` returned
success with a signed provenance statement. Registry propagation is tracked at the end.

## Sequence, with evidence

| Step | What happened | Evidence |
| --- | --- | --- |
| Freeze the candidate | `1831193294` on `dev`, `package.json` 2.57.0 | Cross-platform CI push run `35131181996`: success. First green `dev` run since `35091966777`. **Windows was skipped, not run** — see the correction below. |
| Move `dev`'s version line first | #4827 opened by `dev-version-bump.yml` run `35127386565`, merged as `3f639dfdad` | CI run `35127440220` success after rerunning a cancelled `macos 1/2`; Service lifecycle `35127440065` success. |
| Promote to `main` | #4829 merged as `44de45dfdc` | Merge commit, matching the 2.56.0 promotion #4694. `enforce-target` red by design. |
| Prove the release SHA | `44de45dfdc` | Cross-platform CI run `35133242171`: success. Service lifecycle run `35133242154`: success. Windows was skipped here too; the shards were run afterwards, below. |
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

## Correction: Windows was never run on the candidate or the release SHA

The "all six Windows shards included" claim above was wrong, and it is worth saying plainly because
it is the sentence a future release would have trusted.

`platform-windows` is dispatch-only by design — `.github/workflows/ci.yml` gates it on
`github.event_name == 'workflow_dispatch'` — so on a `push` or `pull_request` event the six shards
are always `skipped`, and the aggregate `ci` check accepts a `skipped` producer as a pass. Both runs
cited above are push runs:

| Run | Head | `windows N/6` |
| --- | --- | --- |
| `35131181996` | `1831193294` (candidate) | skipped |
| `35133242171` | `44de45dfdc` (release SHA) | skipped |

The Windows evidence that existed at publication time was run `35134620067` on `1504caaa83` — the
#4825 lane head, not the candidate and not the release SHA. All six shards were green there, which is
why the claim felt true; it was attached to the wrong commit.

**The gap is now closed after the fact.** Dispatch `35139132889` ran `ci.yml --ref main -f lane=all`
at `44de45dfdc`, the exact commit `@bitkyc08/opencodex@2.57.0` was published from, and all six shards
passed individually:

```
windows 1/6=success  windows 2/6=success  windows 3/6=success
windows 4/6=success  windows 5/6=success  windows 6/6=success
```

So 2.57.0 is sound on Windows. What failed was the evidence discipline, not the release.

Two things follow, and both are being handled in the 2.58.0 cycle rather than here:

- The aggregate `ci` gate cannot tell "deliberately not requested for this event" from "was requested
  and did not start", because it accepts every `skipped` result unconditionally. Making that gate
  event-aware is the subject of the CI-integrity lane.
- A release must not be publishable without a Windows `lane=all` at the exact promotion SHA. The
  publish checklist treated that dispatch as a step; nothing enforced it.
