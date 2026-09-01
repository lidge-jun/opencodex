# 050 — Batch E: needs-info bug issues

Five issues carry `needs-info`: #3155, #3150, #3141, #3136, #1419.

`needs-info` means a maintainer asked the reporter for something. The honest dispositions
are narrow:

1. **The information arrived** — the issue is actionable; move it to Batch F.
2. **The information never arrived and the issue is unreproducible without it** — close
   with a comment naming what was asked, when, and that it can be reopened with the
   detail. Age matters: #1419 dates to a much older Bun version.
3. **The tree answers the question** — resolve it from the source and either fix or close
   with the explanation.

**Never close one merely to reduce the count.** Each closure comment must name the specific
evidence, and any that genuinely needs the reporter stays open and counts against the
target. That is what the 5-item fallback exists for.

Per issue, check: the last reporter comment date, whether the named version is still
current, and whether the described behavior still exists in the tree.

## Verification (C)

For each: closure comment naming evidence, or an explicit recorded blocker.

