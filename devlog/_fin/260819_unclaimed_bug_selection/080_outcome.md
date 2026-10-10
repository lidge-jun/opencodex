# 080 — Outcome

Terminal outcome: **DONE.** Selection and roadmap only; no `src/` change, no PR
merge, no GitHub mutation, no push.

## Result

Nine open `bug` issues have no PR intending to close them. Six are selected for
work after stage 3d, three are deferred with reasons.

| Rank | Issue | Disposition |
|---|---|---|
| 1 | #2114 systemd bus | **unblock PR #2029**, not a new PR |
| 2 | #2107 service proxy env | take, clean of open work |
| 3 | #1933 tray encoding | take, clean of open work |
| 4 | #2108 Windows reboot gate | phase 1 (log the reason) first; coordinate with #2101 |
| 5 | #1527 residual | take only the abort-teardown slice |
| 6 | #1587 deferred catalog | last — most contested files |
| — | #1049 | defer: no field incident, phase 2 can corrupt `CODEX_HOME` |
| — | #1419 | defer: native Bun trap, no upstream release to move to |
| — | #1730 | close as reporter-withdrawn |

## What the audits changed

Two rounds ran. Neither merely agreed, and both errors were in the *method*
rather than in any individual finding.

**The candidate filter was wrong in kind, not in execution.** It asked "does an
open PR mention `#NNNN`" and subtracted the matches. That over-excludes exactly
where an author was honest about scope: PR #2054 mentions #1527 and says
"Does not close #1527", so the filter counted an explicit disclaimer as a
claim. Reference-counting is not claim-counting, and the set was 9 rather
than 8.

**The collision analysis asked the wrong question.** It checked "does this fix
touch a file the split rewrites" and concluded only #1587 collides. The
question that matters is "does an open PR already own this code", and the
answer changes the top of the ranking: **PR #2029 already edits
`inspectSystemd()`** — the exact function #2114 needs — and is
`CHANGES_REQUESTED` for the same fail-open hazard that `020` independently
rediscovered and wrote down as "test 3".

So #2114 is still first, but "first" means supplying the containment #2029's
reviewer asked for. Left uncorrected, this unit would have sent someone to open
a second PR against a blocked one and make the same fail-closed
security-adjacent decision twice.

Smaller corrections, worth recording because they are the kind that waste an
hour: `040` cited `native-main-owner.ts:272`, which is `if (released) return`
inside `release()` — the terminal `unavailable` is at `:205-212`. `060` named a
verification file that does not exist (`tests/tray-windows.test.ts`; the real
one is `tests/windows-tray.test.ts`).

## What the investigation found that the titles did not

Three of nine issues do not describe their own cause:

- **#2107** reads as a WSL networking problem. It is `buildUnit()` baking six
  environment variables and no proxy ones, so the service talks direct while
  the shim inherits the user's proxy. The discriminator is the status code:
  502 with `connection-reset`, not #2108's 503.
- **#1933** reads as "missing package files". That phrase is a collapsed
  summary string; the cause is `reg.exe` output decoded as UTF-8 when the
  console code page is Windows-1252, and `decodeWindowsTextBytes` already fixes
  this class for `schtasks`.
- **#1730** reads as an OpenCodex tool-call bug. The half that was ours shipped
  in `ea0608611`; the reporter attributed the rest to their own configuration
  and asked to close.

And one issue produced a measurement rather than an argument: **#1587** — a
lane ran this tree's real `parseRequest` against a captured Codex Desktop
catalog and found **32,927 of 34,404 bytes (95.7%) deferred and emitted
anyway**. The issue's own "3-5x" headline does not survive scrutiny (it
compares three tokenizers), so the success criterion should be stated in bytes
we control.

## Follow-ups this unit identified but does not own

Both were named in a lane report and would otherwise vanish:

1. Unsupervised `ocx gui` spawns the proxy detached while launchd `KeepAlive`
   covers only `ocx service` (`src/cli/dispatch.ts:255`). Separable from
   #1419's untestable trap, and unlike it, testable.
2. A stale tray has no in-product repair path: the GUI hides Install when
   `tray.stale`, and Uninstall also refuses on a mismatched parse.

## Method note for the next triage pass

The cheap derivation — scan PR bodies for `#NNNN`, subtract — is a starting
filter, not an answer. Two checks have to follow it:

1. **Read the referencing PR.** Does it intend to close the issue, or does it
   say it does not?
2. **Check code ownership, not just issue references.** An issue with no PR
   mentioning it can still have a PR sitting on the function that must change.
