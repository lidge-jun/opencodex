# 010 — Ranking and selection

Evidence: `000_investigation.md`. Criteria are stated first, then applied.

> **Revised after audit.** Two corrections landed here: `#1527` was wrongly
> excluded from the candidate set (PR #2054 says "Does not close #1527"), and
> `#2114` is not greenfield — open PR #2029 already edits the same function and
> is `CHANGES_REQUESTED` for the exact hazard this unit rediscovered. Both are
> folded in below.

## Criteria (stated before the ranking)

1. **Severity of user-visible breakage.** Total loss of a path outranks
   degradation, which outranks cost.
2. **Workaround availability.** A user who is stuck with no way out ranks above
   one who has a documented escape.
3. **Blast radius.** Platform reach and what fraction of that platform's users
   can hit it.
4. **Regression or long-standing.** A path that *used to work* and now does not
   ranks above a gap that was never filled — we broke it, and someone upgraded
   into it.
5. **Evidence quality.** Can a fix be written and verified from what is in the
   thread today, without waiting on a reporter.
6. **Fix cost and risk.** Cheap and containable outranks invasive, at equal
   severity. Risk of *causing* a worse failure counts against.

Deliberately **not** criteria: issue age, comment count, or how loud the thread
is. Two of the strongest candidates here were filed today.

## Ranked

| # | Issue | Sev | Workaround | Radius | Regression | Evidence | Cost/Risk |
|---|---|---|---|---|---|---|---|
| 1 | **#2114** systemd bus | total native loss | yes, obscure | Linux containers/WSL | **yes** | strong | low, but **owned by PR #2029** |
| 2 | **#2107** proxy env | total upstream loss | yes | Linux/WSL behind a proxy | no | partial-strong | low |
| 3 | **#2108** Windows reboot | total native loss | yes, restart | Windows scheduler installs | **yes** | partial | medium |
| 4 | **#1587** deferred catalog | cost, every turn | lossy only | all platforms | no | strong+measured | medium, product risk |
| 5 | **#1933** tray encoding | feature unusable | partial | Windows non-ASCII paths | no | strong | **very low** |
| 6 | **#1527** Cursor residual | collapse at 80k+ | yes, use CLI | Cursor adapter users | no | strong on teardown, partial on cause | split: one small, rest acceptance |
| 7 | **#1049** substrate adoption | none observed | n/a | pre-substrate homes | no | strong mechanism, no incident | **high** |
| 8 | **#1419** Bun SIGTRAP | process death | yes, service | macOS + local TLS proxy | no | partial | not ours |
| 9 | **#1730** Camel | none | yes | one custom provider | no | withdrawn | close, do not patch |

## Selected: #2114, #2107, #2108, #1587, #1933, and one slice of #1527

### Why #2114 is first

It is the only candidate that scores worst-case on severity **and** regression
**and** evidence at once. A user in a systemd-containing container gets 100%
native-OpenAI failure, the path worked before `a2e4fcf47`, and the only escape
is to notice that hiding `systemctl` from PATH fixes it — which no one will
guess.

The clincher is that the repository **currently asserts the bug is correct
behavior**: `tests/codex-service-manager-probe.test.ts:277` pins
`status: 1, "Failed to connect to bus"` → `unknown`. That test has to be
amended deliberately, which makes this a decision rather than a patch, and it
is the kind of decision that quietly ages badly if deferred.

**But "first" means unblocking, not opening.** PR **#2029** (fixes #1939)
already edits `inspectSystemd()` and its test, and is `CHANGES_REQUESTED`
because a reviewer objected that a missing bus is not proof the unit file is
absent — the same fail-open hazard `020` independently arrived at.

So #2114 and #1939 are one probe-policy decision with two symptoms: a refused
sync and a native 503. Ranking #2114 first is right; treating it as a fresh PR
would mean two people making the same fail-closed call in two places.

### #1527 — added to the selected set, but only one slice

It reached the candidate set late, so it is ranked on the same criteria rather
than grandfathered in. The residual after #2054 is five items, and they do not
share a cost:

- **Take now:** the abort-teardown misclassification. Normal completion never
  sets `expectedClose` (`live-transport.ts:738`) while the abort listener
  unconditionally fails the turn (`:1157`), so a turn that already emitted
  `turnEnded` still logs `turn-failed`. Small, independently testable, and
  independent of #2054.
- **Defer:** the kimi-k3 collapse and the 429 asymmetry are **acceptance work**
  that cannot start until #2054 lands, and the 429 half may not be provable at
  all — Connect does not expose `cache_read_tokens`, so `cached_tokens: 0`
  cannot distinguish a cache hit from a miss.

Splitting it this way is the point: the issue as filed is unfixable in one
step, and one third of it is a clean small fix hiding behind two thirds that
need a live workload.

### Why #2107 is second despite not being a regression

Same severity class — the proxy cannot reach upstream at all — and the
mechanism is the cleanest of the eight: `buildUnit()` bakes six environment
variables and no proxy ones. It is a small, well-bounded change to a file we
own, and the same hole exists in the launchd and Windows builders, so one fix
closes three surfaces.

It ranks below #2114 only because it is long-standing rather than a regression,
and because the affected population needs a proxy in the first place.

### Why #2108 is third and not first

Higher-profile platform, and the reporter is a Windows user hitting it on every
reboot. But: the trigger is **not identified** — the lane found two plausible
paths and could not distinguish them because the gate reason is never logged.

That makes the honest first step *logging the reason*, not fixing a mechanism
we have not confirmed. It also shares the fence layer with #2114, so doing
#2114 first produces the retryable-fence groundwork this one needs.

### Why #1587 is fourth

It is the only candidate with a hard measurement: 95.7% of a real captured
catalog was deferred, and all of it was emitted anyway. That is a permanent tax
on every routed first turn for every user with connectors installed.

It ranks below the three outages because it is cost rather than breakage, and
because the fix has genuine product risk in both directions: strip too much and
routed models lose plugin visibility (the #1522 class), strip too little and
nothing improves. The headline "3-5x" also does not survive scrutiny — the
thread compares three different tokenizers — so the goal should be stated in
bytes we control, not in a ratio.

### Why #1933 is fifth despite being the cheapest

The fix is close to trivial: route two `reg.exe` reads through
`decodeWindowsTextBytes`, which already exists and already has a
`C:\Users\Jörg` fixture from #1573. It is fifth only because the tray is not on
the request path — nobody's requests fail because of it.

It is worth doing precisely *because* it is cheap: it closes a
known-class-missed-a-site bug, and leaving a fixed class half-applied is how
the next one gets missed too.

## Deferred, with reasons

## Audit challenge to this ranking, and what changed

An audit lane argued the ranking is "wrong as a user-harm ordering — it listed
blast radius third, then let evidence and *we can patch today* pick the
winner." Three specific challenges. Two are accepted, one is not.

### Accepted: #2108 outranks #2114

The lane is right. Both are total native loss and both are regressions. Windows
scheduler installs dwarf "Linux host where systemctl is present but the user
bus is not", and #2108 recurs **on every reboot** rather than once at install.
Ranking #2114 first because its trigger is known and a test pins it is
maintainer convenience dressed as impact.

The "do #2114 first for fence groundwork" argument was also refuted separately
(see `040`): it was a preference, not a dependency. With that gone, nothing
defends the original order.

**Revised: 1 #2108, 2 #2114, 3 #2107, 4 #1587.** Partial evidence on #2108 is
the reason its phase 1 is *logging*, not the reason to bury it at rank 3.

### Accepted with a change of shape: #1049 returns as detection-only

"Integrity bugs are silent; the first report is a corrupted Codex home" is a
better argument than the one this doc made. Waiting for a field incident is the
wrong posture for a data-integrity gap, and `000` already grades the mechanism
as strong.

But the original deferral was not only about the incident count — the invasive
half can corrupt the thing it protects. Both concerns are satisfied by
splitting it:

- **In:** phase 1, the atomic no-clobber publish for the ordinary clean
  `{0,null}` row, plus refusing to write when adoption state is indeterminate.
  That is detect-and-refuse; it reduces risk rather than adding it.
- **Out for now:** phase 2 (`adoption-pending` schema, the native handoff),
  which is where the corruption risk lives and which needs a Windows
  no-replace primitive we do not have.

### Not accepted: drop #1933

The lane called #1933 "the ranking's worst trade" and would fold it into the
Windows pass. Folding it in is fine. **Dropping it is not**, and the reason is
not severity:

`decodeWindowsTextBytes` already exists and is already wired into the service
probe. #1933 is that same class at a site that was missed. A class fix left
half-applied is how the *next* site gets missed, and the cost here is two call
sites plus a test that reuses an existing fixture.

It also is not costless to the user: with a stale tray the GUI offers **no
repair path** (Install hidden, Uninstall refuses), so the person who hits it is
stuck without a documented manual registry edit.

Accepting the fold: it rides the #2108 Windows pass rather than occupying its
own slot.

### Final selection

`#1527` has since been investigated (see `000`), and a fourth audit round found
that `#2114` is not greenfield: open PR **#2029** already edits
`inspectSystemd()` and is `CHANGES_REQUESTED` for the same fail-open hazard
`020` rediscovered. Folding both in:

```
1  #2108  Windows reboot gate      phase 1 = log the reason; coordinate with PR #2101
2  #2114  systemd bus             UNBLOCK PR #2029 — do not open a parallel PR
3  #2107  service proxy env       clean of open work
4  #1527  abort-teardown slice    small, independent of #2054
5  #1587  deferred catalog        last: most contested files
6  #1049  phase 1 only            atomic publish + refuse-on-indeterminate
   #1933  folded into the #2108 Windows pass
```

Still deferred: `#1049` phase 2 (schema + native handoff, where the corruption
risk lives), `#1527`'s kimi-k3 and 429 halves (acceptance work that cannot
start until #2054 lands, and the 429 half may be unprovable while Connect hides
`cache_read_tokens`), `#1419` (upstream-blocked), `#1730` (close as withdrawn).

**This supersedes the header table at the top of this document**, which records
the first-pass ordering before the audit rounds moved it. The table is kept
deliberately — the movement from it to here is the useful part.

**#1049 — defer, and say why in the issue.** The mechanism is real and well
traced, but there is no field incident behind it: no user logs, no crash, no
report. Meanwhile the lane's phase 2 carries the highest risk in this entire
set — a wrong publish can corrupt a user's Codex home, and Windows needs a real
no-replace primitive rather than a POSIX hardlink. Spending that risk budget on
a gap with no observed failure, while three total-outage bugs are open, is the
wrong trade. Revisit when either a real incident arrives or the split program
has settled and there is appetite for careful substrate work.

**#1419 — defer as upstream-blocked, keep needs-info.** The trap is inside Bun.
Bundled Bun is 1.3.14 and upstream's latest release is still 1.3.14, so there
is nothing to bump into, and the reporter never supplied the `.ips` frames that
would let us file a useful upstream issue. Do **not** weaken TLS verification to
work around it.

One separable piece *is* ours and should be split out rather than lost: `ocx
gui` spawns the proxy detached and unsupervised while launchd `KeepAlive` only
covers `ocx service`. That is a survivability fix with a real test, and it is
worth its own small issue instead of riding a crash we cannot reproduce.

**#1730 — close as reporter-withdrawn.** The half that was ours (`exec` losing
its description in custom-tool conversion) shipped in `ea0608611`. The remaining
claim has no OpenCodex mechanism, and the reporter attributed it to their own
Responses-vs-Chat-Completions misconfiguration and asked to close. The proposed
fix — a `stream.camelai.com` + `deepseek-v4-flash` first-round
`tool_choice: required` hardcode — would change tool-selection semantics for
every user of that route based on one host, with no public contract and the
reporter now opposing it.

Closing it is a real outcome, not a dodge: it removes a `bug`-labelled issue
that would otherwise keep re-surfacing in triage as unclaimed.
