# 070 — closeout: what landed, what did not, and why

## Landed on `dev`

| Item | PR | Merge SHA | Issue |
|---|---|---|---|
| Copilot context window | #3163 | `e236c36239c93f006a706aba3e7c84da167b5dd9` | #3156 closed |
| Request-owned main pin | #3166 | `75090d4e0e26637a3db0157edf3090830ba00d52` | #3157 closed |
| `ocx models` dispatch | #3171 | `e92aa336a83c86283b500269a1d55779836114b0` | #3094 closed |
| Combo default effort | #3172 | `7386b52016be7b0246ca941d4e285ec340331431` | #3108 closed |
| Remote-hub reference docs | #3173 | `0d8147c2002e3e4e4adf39a03084d6a6ab18991e` | #3158 T19/T21 |
| Failover e2e assertion | #3175 | `22a643a00b5974fa53b084a04491f60d56ec9ee2` | follow-up to #3108 |

Every SHA verified with `git merge-base --is-ancestor <sha> origin/dev` exiting 0.

Six pull requests merged, four issues closed. The objective asked for at least three
bug/PR items; ten items moved.

## Did not land, deliberately

**#2986 / #2083 — xAI Imagine relay.** The roadmap assumed a clean carry awaiting a merge.
The refresh at execution time said otherwise: `BLOCKED`, `CHANGES_REQUESTED` from maintainer
@Ingwannu, and a base 179 commits behind `dev`. One of the three requested fixes is a
`MAX_DOWNLOAD_BYTES` cap dropped on a credentialless download path — a security-boundary
defect. Admin-merging over that would have spent maintainer authority to bypass the
maintainer. Recorded in `031_wp3_disposition.md`.

**#3158 T2 and T3.** Behaviour gaps, not documentation. The issue stays open for them.

## What the loop got wrong, and how it was caught

Two plan claims did not survive contact:

1. **The import the plan proposed was unsafe.** 050_phase5.md originally suggested importing
   `effectiveComboDefault` from `aggregation.ts` into `request.ts`. The A-gate auditor and
   an independent trace both found that closes a cycle (aggregation already imports
   `src/combos`) and drags `node:child_process`, `oauth`, `model-cache`, and
   `cursor/live-models` onto the request path. Repaired before implementation: the resolver
   moved to `src/reasoning-effort.ts`, a leaf whose only import is `./types`.
2. **`allowInsecureHttp` is retired, not a live setting.** 060_phase6.md planned to document
   it as a security-relevant opt-out. The source says it grants nothing and is parsed only so
   an older config keeps loading. Documented as retired instead.

And one implementation gap the local scope missed:

3. **A stale assertion in the failover e2e suite.** The scoped local runs for #3172 covered
   `combos.test.ts`, the catalog suite, and the boundary suite — not
   `server-combo-failover-e2e.test.ts`, which held an assertion encoding the old
   drop-on-miss behavior. CI on the merged `dev` head caught it within minutes and #3175
   corrected it. This is the cost of the no-local-suite policy, and it is a cheap one: the
   trailing CI signal did exactly the job it was left to do.

## Verification policy actually used

No repository-wide local suite was run, per instruction. Each change was gated by focused
`bun test` files plus red-green proof that the new regression genuinely fails without the
fix, with CI trailing the train and judged at the end.

## Final CI verdict

Run `33533338305` on `dev` head `22a643a00b5974fa53b084a04491f60d56ec9ee2` —
**completed success**, zero failed jobs across the full matrix (Linux shards 1-4, macOS,
keyring, npm-global, gates, storage policy, api usage, hygiene).

That head contains every landing in this train. The trailing-CI policy is therefore
discharged: nothing merged here leaves `dev` red.
