# Substrate audit round 2 — synthesis

Verdict: **FAIL**. One closed (#12), eleven still open, five new (three High).

## The honest read of this round

I wrote a contract phase and it did not do the job, for a reason worth naming:
**I declared ownership without transferring it.** `005` says it owns the record,
the route and the entry point — and `020`, `030`, `040` still contain their own
versions, because I never rewrote them. The reviewer's "PHASE DOCS THAT MUST
CHANGE" section is 30-odd concrete sections long. Declaring a contract and
leaving three docs that contradict it is not a contract; it is a fifth opinion.

That is the same shape as round 1, one level up. Round 1: four authors, no owner.
Round 2: an owner who did not collect.

## The finding that changes a design decision

**#7 — the per-user namespace.** I accepted the reviewer's round-1 fix
(`os.userInfo().homedir` instead of `homedir()`) and specified it. The reviewer
then **ran it on our pinned Bun 1.3.14** and both returned the fake `HOME`. I
reproduced it:

```
HOME=/tmp/fakehome bun -e '...'
homedir:  /tmp/fakehome
userInfo: /tmp/fakehome
uid: 501   username: jun
```

So the fix I wrote does not work in the runtime we ship on. But the probe also
shows the way out: **`uid` and `username` are real**. The namespace must be keyed
on effective-user identity — uid on POSIX, account SID on Windows — not on any
home path, since every home path in this runtime is environment-controlled.

This is the single most valuable thing either round produced, and it only
surfaced because the reviewer executed the claim instead of reading it.

## The three new High findings, all accepted

**N1 — the caller picks the direction.** `ConvergeRequest.intent` accepts
`apply | remove`, which lets `/api/sync` skip while OFF instead of removing
residue, violating C11 — and it contradicts `040`, which says callers cannot
supply desired state. Fix: the request carries `converge | observe` only, and
the direction is derived from admitted persisted intent. The caller says *when*,
never *which way*.

**N2 — WP8b cannot land first as written.** It is "OUT: every behavior" yet
declares a runtime entry point and references types later phases define. A
throwing placeholder is not a safe first commit, and a compatibility shim would
bypass the very authority it establishes. Fix: WP8b becomes a complete
types/validators/adapter phase that rewires nothing, OR it lands the whole safe
funnel. Either way **every phase must typecheck and preserve behavior at its own
commit** — that is what "one phase, one boundary" has to mean operationally.

**N3 — the generation protocol treats its own commit as interference.** A
counter bumped by every native commit, compared before and after, always
mismatches after a successful write. I specified a mechanism whose success
condition is indistinguishable from its failure condition. Fix: an expected
transition — `N → N+1 by us`, identified by a transaction id — with explicit
bump ownership and crash ordering.

## #5, restated because I got the direction wrong

C2 says a stale candidate cannot be committed. I specified detect-after-commit
and promised re-convergence, which permits exactly the write C2 forbids. The
reviewer points at `030`'s own text: the native lock may hold the config
mutation lock through the synchronous re-read and commit. So **prevention is
available for cooperating writers**, and post-commit detection is only for
writers that ignore the coordinator. Accept, with the retry bounded by
`deadlineMs` and a typed unresolved reason when it expires.

## #4 — scope creep I introduced

`present-required-nonempty` came from the live Pi incident and names no baseline
bytes, no client schema and no validator, while the six file clients are
explicitly out of scope. The reviewer is right: for Codex, `present` plus exact
baseline bytes already expresses restoration. The class goes back to
`FOLLOWUP-FILECLIENT-01` where the incident belongs.

I added it because the incident was fresh and I wanted it housed. Housing a
finding in the wrong unit is not housing it.

## Disposition

Sixteen open items, all accepted, nothing rebutted. I verified the Bun probe
myself before accepting #7.

## The correction, and why it is not another rewrite round

Two audit rounds have now failed on the same axis: documents that disagree with
each other. The fix is not a third round of parallel edits — it is to **collapse
the four phase docs into the contract**, because the audit has demonstrated that
four docs cannot be kept consistent by review alone.

Concretely:

1. `005_contract.md` absorbs every shared surface **completely** — full section
   types, the exhaustive outcome union, the single adapter, generations with
   expected transitions, the uid/SID namespace, and the corrected
   `converge | observe` request.
2. `010`, `020`, `030`, `040` are rewritten as **consumers**: each keeps only its
   own mechanism and imports everything shared. The reviewer's section list is
   the checklist.
3. Each phase must typecheck and preserve behavior at its own commit (N2).
4. `050_composed_acceptance.md` is written before implementation, not after.

That is a real amount of work, and it is smaller than shipping a substrate whose
four documents contradict each other in thirty places.

## Carried forward

| Finding | Disposition |
|---|---|
| #1 history overtaking + CLI inline | contract: one history lock, expected-transition rejection, all callers |
| #2 funnel not provable by grep | contract: writers move to an internal module, reachability-enforced |
| #3 three schemas | contract: complete section types; `020`/`040` import them |
| #4 route mapped three times | contract: one exhaustive adapter; remove from all three |
| #5 detection vs prevention | contract: hold config lock through commit for cooperating writers |
| #6 one counter, two jobs | contract: separate config and native generations, expected transitions |
| #7 namespace | **uid/SID**, proven necessary by the Bun probe |
| #8 digest with nothing to compare | contract: authoritative re-read inside the commit; withdraw the one-read claim |
| #9 60-tick dormancy | `020`: capped backoff that never becomes permanent |
| #10 provenance recovery + ABA | `040`: operator adoption path; narrow C10 to current-byte drift |
| #11 WP13 placeholder | write `050` before implementation |
| #12 scope honesty | **closed** |
| #13 module names | `040` still names two wrong modules |
| N1 caller-chosen direction | contract: `converge \| observe` |
| N2 WP8b cannot land first | contract: types/validators/adapter only, or the whole funnel |
| N3 self-interference | contract: expected transition with a transaction id |
