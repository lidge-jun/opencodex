# 000 — PR and issue sweep: land the image fix, resolve the duplicates, triage the backlog

## Objective

Bring the open bug surface to a state where every item is either landed,
closed with a reason, or carrying a verdict grounded in code somebody actually
read. Three fronts were named: the image-forwarding fix, the duplicate pull
requests, and the standing issue backlog.

## What the research round overturned

Five sol-medium explorers were dispatched in parallel against `origin/dev` at
`fa51fce5414260c1c9955a7e67b06e7a960bec05`. Two working assumptions did not
survive contact with the evidence, and one PR slated for closure turned out to
be load-bearing.

**#837 and #616 are not two competing implementations.** They are the same
implementation. `git` authorship shows #837's substantive commit `89d51dbc`
carries author `Eleven-is-cool` with authored timestamp `2026-07-28T12:23:13Z`
— byte-identical to #616's `1aba0e4b` — replayed onto a newer base with
`Ingwannu` as committer. The diffs match at +819/-18 across the same 16 files.
The second #837 commit is a one-line fixture adjustment for schema
normalization that only exists on the newer base. So #837 is the integration
vehicle for #616's work, already crediting it, and the question is not which
author wins but whether the shared implementation is correct.

**Nothing in the standing backlog was silently fixed.** The premise going in
was that recent merges (#892, #917, #880, #899) would have closed several
issues by side effect. Of twelve issues examined against current code: zero are
already-fixed. Eight are still real, three need reporter information, and one —
#553 — is closeable, but as an environmental fault rather than a shipped fix.
The reporter's own evidence showed a Shadowrocket fake-IP DNS route returning a
NetEase certificate; the Copilot transport correctly refuses to weaken TLS
verification for it.

**#916 is not superseded by #917.** It was expected to overlap heavily with the
security work merged an hour earlier. It does not. #917 introduced
`managementPrincipal()` and closed the star-consent bypass; #916 authenticates
the CLI's *outbound* management listener, which is a different boundary. The
auditor reproduced four High-severity defects on current `dev` directly:

```text
Claude: {"baseUrl":"https://attacker.example","token":null}
Bun:    {"path":"/Users/jun/.bun/bin/bun","source":"override",...}
Health: {"seen":"Bearer ocx_admin_AAAA...","source":"management-api-unavailable"}
```

An ambient `ANTHROPIC_BASE_URL` survives credential stripping and redirects
OAuth-bearing traffic; `OPENCODEX_BUN_PATH` is reread after Bun loads project
dotenv, so a repository-local file can persist the durable executable; and the
admin token is handed to any listener that answers a forgeable `/healthz`.

## Work-phase map

Dependency order, not effort order. Each phase closes with something
independently verifiable.

| Phase | Doc | Unit | Depends on |
|---|---|---|---|
| 1 | `010` | Land #912 tool-result image forwarding | — |
| 2 | `020` | Rebase #837, fix two shared defects, land, close #616 | — |
| 3 | `030` | Compact alternate-account attempt (#913) | — |
| 4 | `040` | Backlog disposition: comment, close, or record | — |
| 5 | `050` | #916 salvage plan and closure | 2 (shared rebase surface) |

**Phases 1–4 are mutually independent.** Phase 3 is now the only code change to
the routing subsystem in this unit, confined to the native compact branch in
`src/server/responses/compact.ts`.

**What used to be Phase 3 is gone.** It carried #914 and #919. Both left for
`devlog/_fin/260803_transport_attribution/` after the audit gate showed each
is a policy decision about account-health attribution rather than a local fix.
The earlier tables in this document showed a 3→4 hard dependency and then
dropped it; with the transport work gone entirely, no such edge exists.

**Phase 5's dependency was originally stated wrong.** The first version claimed
#916 must land last because the transport phases would move
`src/server/index.ts`. They never touched that file; #916's conflict there is
purely against #917, which already landed. The real overlap is Phase 2: both
touch `src/config.ts`, `src/server/auth-cors.ts`, and `tests/config.test.ts`.
Current hunks dry-run cleanly, but Phase 2 lands first so #916 rebases onto a
settled config surface.

## Out of scope

Releases and version cuts. `scripts/release.ts` runs from `preview`/`main` and
has not been authorized. `dev` is 215 commits past `v2.10.0`; that is a
conversation to have, not a step to take inside this unit.

#915 (cooldown recovery probe) is real but rated High cost: it crosses routing
state, auth resolution, WHAM refresh concurrency, account generations, and
quota scopes, and needs a generation-fenced background probe rather than
ordinary account selection. Deferred to its own unit,
`devlog/_fin/260803_cooldown_recovery_probe/`, named here so the deferral is a
scheduled unit rather than a comment on an issue that nobody reads again.

#893 (sparse Responses snapshots) is real, but the closed PR #894 that
addressed it was 1,168 additions across 23 files. Narrowing that to a
provider-local default-off repair is its own unit,
`devlog/_fin/260803_sparse_snapshot_repair/`.

#914 and #919 (transport failure attribution, before and after HTTP 200) left
this unit after four audit rounds. Their analysis and the full rejection
history live in `devlog/_fin/260803_transport_attribution/`. Both issues stay
**open**; nothing in this unit fixes either.

The #915 and #893 deferrals were checked by the plan reviewer against the
issues themselves and judged defensible rather than scope evasion — but only on
the condition that they become named units. That condition is met above. The
#914/#919 deferral is a separate matter: it was not a scheduling choice but the
audit gate's own conclusion, recorded below.

## Audit history

The audit gate ran five rounds: four FAIL, then GO-WITH-FIXES. Every rejection
landed before a line of code was written. They came from a mix of runtime
probing, ordinary code reading, and — in the last round — reading this
repository's own archived decision records. The mix matters: a reviewer who
only ran probes would have missed the test and phase-contradiction blockers;
one who only read current code would have missed that the pinned runtime does
not emit the error codes the plan was matching on; and one who read neither the
archive would have let #919 through as a bug fix when it is a policy reversal.

The outcome was not another revision of the guard. The whole transport-
attribution phase left this unit, taking #914 and #919 with it. What remains
here is work whose correctness does not depend on an unsettled policy question.

**Round 1 — FAIL.** The plan matched Node error codes (`ENOTFOUND`,
`EAI_AGAIN`, …) on the fetch rejection. Bun 1.3.14 does not emit them: a
nonexistent hostname and a refused port both yield `ConnectionRefused`,
`errno: 0`, no `cause`. The guard would have passed a unit test that injected
the code by hand and never fired in production. Reproduced independently before
amending. Two further blockers: two existing tests were mischaracterized as
encoding the defect (they test valid lower-layer behavior and now stay
untouched), and Phase 4 contradicted Phase 3 on alternate-account attribution.

**Round 2 — FAIL.** The amended plan kept a classifier but resolved the
hostname with `dns.lookup()` to decide neutrality. Rejected for two reasons.
Bun's labels are not a stable set — repeated fetches to the same `.invalid`
host alternate between `ConnectionRefused` and `FailedToOpenSocket` as Bun
evicts its DNS cache, so every other request would have skipped the probe. And
"the name resolves, therefore the account is at fault" does not follow: a
resolving host can still refuse TCP through a firewall, VPN, or fake-IP proxy —
a case this repository explicitly supports at
`src/lib/destination-policy.ts:175`.

**Round 3 — FAIL.** The third design stopped classifying the error and used the
boundary instead: a rejected `fetch` means no response header arrived, so no
server evaluated the credential. The supporting fact — that
`applyCodexAuthContextToProvider()` (`src/codex/auth-context.ts:310`) swaps the
token without changing the destination — is true and verified. The boundary
claim is not. The reviewer drove two counterexamples through the real wrapper:
Bun follows redirects by default, so a server can receive the authenticated
request, return 307 to a dead host, and produce a rejection *after* headers
arrived; and a server that reads `Authorization` then closes the socket yields
`ECONNRESET` with the credential already seen. A credential-aware upstream can
do either differently for A than for B.

Round 3's resolution moved #914 out and kept #919, on the grounds that #919
"never depended on inference" — the synthetic/real distinction is already
carried on `RequestLogContext`, so the fix reads a field.

**Round 4 — FAIL.** That was wrong too, and the reviewer proved it from the
repository's own history rather than from the runtime. The synthetic 502 that
#919 objects to was introduced deliberately, by
`devlog/_fin/260722_issue_bug_sweep/030_patch_s_sticky_502.md`, with a source
comment that is still there: report `failed` with a synthetic 502 *so that the
account-health recorder treats it as a transient upstream failure*. That
patch's own test matrix records the intended outcome as "transient 실패 기록,
affinity 해제" — the exact behavior #919 reports as a bug.

So "the proxy invented this 502, therefore it is not evidence about the
account" does not hold. `terminalSource="synthetic"` proves the proxy
manufactured the *event*; the underlying socket reset is still an upstream read
failure, and account health tracks transient reliability, not only credential
validity. Changing it means reversing a considered decision, which is a policy
call needing evidence about whether mid-stream drops correlate with accounts.

**Resolution: the whole transport-attribution phase leaves this unit.** Four
designs died at the same place across two issues, which is evidence about the
problem rather than about the designs. Each tried to answer "was this the
credential's fault?" from evidence insufficient in principle — Bun collapses
distinguishable network conditions into one label, the path can traverse an
authenticating server before failing, and after HTTP 200 the question stops
being about credentials at all and becomes about reliability. The likely
correct direction for both is separating host health from account health. That
work, and the full rejection history including the `5xx → retry rejection`
attempt-history hole, is in `devlog/_fin/260803_transport_attribution/`.

Four rejected designs cost one session and shipped nothing broken. The
alternative was a guard that passed CI and silently changed routing behavior
the repository had already reasoned about once.

## Evidence standard

Every behavioral fix in this unit carries a red-green ablation: the regression
test must fail with the fix removed. A green suite proves nothing about a
branch no test drives. Structural assertions are acceptable only where the
property is invisible to behavior, and then they say so.
