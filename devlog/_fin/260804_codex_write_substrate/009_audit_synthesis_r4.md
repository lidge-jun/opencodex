# Substrate audit round 4 — synthesis

Verdict: **FAIL**, 8 blocking. Nine closed, and one **Critical** that would have
damaged the owner's machine.

## The Critical, first

WP13 invokes `ocx service start/stop/uninstall` as production entry points
(`050:93`). Service identifiers are **global constants**, not derived from any
home: `com.opencodex.proxy` (`src/service.ts:42`), a fixed Task Scheduler task
on Windows (`:1868,1894`), a fixed systemd user unit on Linux (`:2045,2069`).

A `mktemp` `OPENCODEX_HOME` does not namespace a launchd label. So the suite I
commissioned to prove safety would have **stopped and uninstalled the real
service**.

I checked this machine:

```
launchctl list | grep opencodex
72848  0  com.opencodex.proxy
```

It is installed and running right now. This is not theoretical.

The whole unit exists because turning one client off must not disturb anything
else, and its acceptance suite would have torn down the owner's proxy. Rows
P34-P36 leave the workstation suite; they run only on a disposable host proven
to have no installed service, and that requirement is stated in the doc rather
than assumed.

Two smaller versions of the same mistake: lock artifacts land in the fixed
per-user runtime root, outside the `mkdtemp` root the harness deletes, so every
case leaks; and the wrong-owner fixture (`050:235`) cannot be built by an
unprivileged CI account at all, since you cannot create a file owned by another
uid.

## The architectural finding: my CAS is not a CAS

`updateIntegrationRecord` does read/compare/replace "under the caller's
coordinator" (`005:246`) — but native and history hold **different,
non-overlapping** coordinators (`005:632`). So:

1. the history Worker reads pair `N`
2. the native transition writes its pending schedule at `N+1`
3. the Worker replaces the JSON with stale `N`

A separate-file read-modify-write is not conditional just because each writer
holds *a* lock. And this is exactly the overtaking sequence detect-and-repair was
chosen to handle, so #1, #5 and N3 all rest on it.

**Accept.** The pair and the schedule move into a conditional row update in the
coordinator that already exists for config mutation, or a single narrow
cross-process record lock is shared by both domains. A JSON file cannot carry
this invariant.

## The finding that reframes the key

New #2: the native lock is keyed on canonical `CODEX_HOME` alone (`005:715`),
while `integrations/codex.json` lives under each `OPENCODEX_HOME`. Two opencodex
installs pointing at one Codex home therefore **serialize their writes and then
consult different generation counters** — each stale Worker sees its own tx as
current.

I keyed the lock correctly and left the state it protects keyed differently. The
generation and schedule belong in the `CODEX_HOME`-keyed coordinator, or a
competing opencodex owner is refused outright.

## What actually closed

Nine findings, and the reviewer verified rather than accepted:

- **#4** the adapter's `never` check is now structurally implementable
- **#9, #10, #12, #13, N1, N4, N5** all closed
- **Round-3 New #2** WP9's management funnel is catalog-only and forbids
  config/profile/journal/history writes
- **Round-3 New #4** the "no window" reversal held

The reviewer also **counted the census by hand**: exactly 16 management catalog
writes — 6 provider, 6 model, 2 combo, 2 agent-settings — matching WP13's claim,
and confirmed the 14-route/16-site distinction is correct.

## The compile claim, measured

I verified it myself. The ten blocks as printed give two `TS2304` for
`OcxConfig`; adding the real import gives **zero diagnostics**. So the TS2391
that failed round 3 is genuinely gone, and the residue is a missing import line
in the document, not a design defect. The reviewer independently reproduced
both, and additionally found `TS2345` on WP12's request object — it omits
`scope` — and that WP12 still prints the old bodyless form.

That is the useful pattern of this whole audit: claims get compiled, censuses
get counted, and service labels get read out of the source.

## Honest position after four rounds

The reviewer's judgment: *"still not implementable end to end by an outsider.
The remaining work is architectural, not polish."*

I agree, and the trend supports continuing rather than stopping:

| Round | Closed | Open | New |
|---|---|---|---|
| 1 | — | 13 | 13 |
| 2 | 1 | 11 | 5 |
| 3 | 5 | 11 | 4 |
| 4 | **9** | 8 | 5 |

But four of the eight remaining blockers are one question I have now gotten
wrong twice: **where does cross-process transition state live?** A JSON file
under one home cannot be compare-and-swapped, and cannot be shared by two homes.
Answer that once and #1, #5, #6, N3 and New #2 collapse together.

## Next

1. Move generation + schedule into the existing config-mutation SQLite
   coordinator with a conditional row update, keyed so two opencodex homes
   sharing one Codex home cannot diverge. This is the load-bearing change.
2. Give `src/config.ts` the durable counter API, and add it to WP8b's IN list —
   WP9 already delegates the owner there while WP8b's scope excludes the file.
3. One exported resolver returns the FINAL lock path; consumers stop
   re-appending identity and version segments.
4. Publish the writer inventory with permitted roots per domain, since
   `history-worker.ts` must reach history writers and `convergence.ts` cannot be
   the only root.
5. WP13: remove P34-P36 from the workstation suite, add the mid-traversal
   repair scenario, and confine or account for lock artifacts.
6. Adoption requires a verified native-clean observation, or splits into salvage
   then adopt.
7. Small: `scope` in WP12's request, the bodyless form in WP12, the contract's
   final C17 text, unknown-key passthrough at nested levels, and the compile
   prelude import.
