# 060 — Outcome

## What landed

| PR | Issue | Merge | Note |
|---|---|---|---|
| #912 @DevMello | #888 | `1b620266b` | Tool-result images to vision models. Audit PASS, ablation-verified. |
| #924 (rebase of #837/#616) | — | `df8243154` | Hosted image tool preferences. 4 defects fixed on top. |
| #927 | #913 | `87c479006` | Compact alternate-account attempt. 2 activation tests contributed. |

## What did not land, and why that is the result

**#914 and #919 left the unit entirely.** Four audit rounds, four rejected
designs, all falsified before a line of code was written:

1. Match Node error codes on the fetch rejection — Bun does not emit them. The
   guard would have been green against an injected `code` and dead in
   production.
2. Resolve the hostname to decide neutrality — Bun's labels alternate as it
   evicts its DNS cache, and a resolving host can still refuse TCP behind a
   firewall or fake-IP proxy, which this repository explicitly supports.
3. Use the boundary, "rejection means no header arrived" — Bun follows
   redirects by default, so a server can read `Authorization`, return 307 to a
   dead host, and reject after.
4. For #919, read the synthetic/mid-stream label — it records who manufactured
   the terminal event, not who caused the failure, and the eager path's catch
   wraps our own inspection and rewriting too.

The fourth round also found the decision record:
`devlog/_fin/260722_issue_bug_sweep/030_patch_s_sticky_502.md` introduced #919's
behavior deliberately, with `transient 실패 기록, affinity 해제` as the stated
expected outcome. It is a policy, not a defect.

Both moved to `devlog/_fin/260803_transport_attribution/` with the full
history. @luvs01 then opened #922 with a fourth approach that includes Bun's
`ConnectionRefused` — the thing design 1 missed. Reviewed with the probe
evidence and the two post-header counterexamples attached.

**#916 stays draft.** Five hunks worth salvaging, three that must not land —
including a fallback that strips shell-exported credentials on the documented
direct-Bun path. It touches authentication and the durable launcher, so
`MAINTAINERS.md` requires human security review. An agent audit does not
substitute for one.

## Backlog disposition

Twelve issues, zero already-fixed. That was the second overturned premise: the
working assumption was that recent merges had closed several by side effect,
and none had.

Closed: #888, #913 (by merges above), #553 (environmental — the reporter's own
captures showed a fake-IP DNS route returning a NetEase certificate).

Evidence-commented with file:line: #907, #586, #545, #241, #92, #915, #919,
#893, #417.

Information requested, each naming the specific capture that would settle it:
#796, #418, #904.

## Verification

On dev tip `b9d3434d9`:

- `bun x tsc --noEmit` — exit 0
- `bun run test` — 7587 pass, 8 skip, 0 fail, 504 files
- `bun run privacy:scan` — passed
- Sharded CI run `30790453146` — success

## What the audit gate was worth

Five rounds, four FAIL. Every rejection was empirical: a runtime probe, a read
of the actual test being proposed for rewrite, or an archived decision record.
Two of the four would have shipped code that passed CI and did nothing.

The cost was one work-phase of planning. The alternative was three merged
"fixes" for problems that needed a policy decision instead.
