# 080 — Verification of this unit's own claims

> Renumbered to `075` — this is the verification record that sits between the
> sequencing doc and the outcome. `080_outcome.md` is the close-out.
>
> **Update:** the retired lane was replaced. Two later lanes landed
> (`01a019f5` narrow, `01a019ed` wide) and their findings are folded into
> `000`, `010`, `020`, `040`, `060` and `070`. The direct re-verification below
> stands and was independently confirmed by those lanes; what it could not
> catch on its own was the code-ownership collision with PR #2029, which the
> wide lane found.

An adversarial audit lane was dispatched against `000`-`070` and **went silent
past three wait cycles**. Under DISPATCH-RETIRE-01 that is a failed dispatch,
not a pass. Recording it as failed rather than quietly proceeding, and
re-verifying the load-bearing claims directly instead.

## Directly re-verified

### #2114 — the test really does pin the bug

`tests/codex-service-manager-probe.test.ts`:

```
/**
 * systemd does NOT signal absence through the exit code — a missing unit
 * prints not-found and exits ZERO. A non-zero status means the question never
 * reached the bus, which is the opposite conclusion.
 */
test("a non-zero systemctl status is unknown even though a missing unit exits zero", () => {
  const { run } = recorder(() => ({ status: 1, stderr: "Failed to connect to bus" }));
  expect(inspectServiceManagerInstallation({ run, platform: "linux", home }).kind).toBe("unknown");
});
```

CONFIRMED, and the comment is worth reading closely: the reasoning is
**correct** and the conclusion is still wrong for this environment. "The
question never reached the bus" is precisely why `unknown` is the wrong verdict
— an unanswerable question is evidence about the bus, not about who owns the
service home. The test is not sloppy; it encodes a genuine judgment that needs
revisiting for the container case, which is exactly why `020` says amend it
rather than delete it.

### #2107 — `buildUnit` really omits proxy env

`grep -n 'HTTP_PROXY\|HTTPS_PROXY' src/service.ts` returns **nothing**.
CONFIRMED. There is no proxy key anywhere in the service builder, which also
confirms the doc's claim that launchd and the Windows wrapper share the hole.

### #1587 — the flag really is discarded

`grep -n 'defer' src/types.ts` → empty. `OcxTool` has no such field.
`rg 'defer_loading' src/responses/` → empty. The parser never reads it.

CONFIRMED on both halves, which is the part that matters: the measurement
(95.7% of a captured catalog) came from a lane and cannot be re-run here, but
the *code claim* it rests on is directly verifiable and holds.

### #1933 — the encoding asymmetry is real

```
src/tray/windows.ts:122          encoding: "utf8",
src/tray/windows.ts:338          encoding: "utf8",
src/service-manager-probe.ts:29  import { decodeWindowsTextBytes } from "./lib/windows-text";
src/service-manager-probe.ts:476 decodeWindowsTextBytes(queried.stdout, ...)
```

CONFIRMED. The helper exists, the service probe already uses it, and the tray
reader does not. This is the clearest "known class, missed site" in the set.

### Sequencing — the collision analysis is complete

Checked each selected fix's files against what the split PRs rewrite:

| File | In split diff |
|---|---|
| `src/service-manager-probe.ts` | no |
| `src/service.ts` | no |
| `src/tray/windows.ts` | no |
| `src/codex/native-profile-startup.ts` | no |
| `src/codex/native-main-owner.ts` | no |

CONFIRMED: `#1587` is the only collision, via `src/types.ts`.

## What remains unverified, and is labelled as such

- **The #1587 byte measurement.** 32,927 / 34,404 came from a lane replaying a
  captured catalog through the real parser. Not reproduced here. The mechanism
  is confirmed; treat the exact percentage as one sample.
- **#2108's actual trigger.** Two candidates, and the doc says so plainly. This
  is a genuine gap, not an oversight — it is *why* `040` puts logging first.
- **The candidate-set completeness re-derivation.** The list was derived once
  live (`2026-08-19T11:45:42Z`) and not independently re-derived by a second
  party. A PR opened after that timestamp could claim one of these eight. Cheap
  to re-check at start of work, and `070` should be re-read then rather than
  trusted.

## Note on lane reliability in this unit

## Second audit round — the one that landed

The first audit lane was retired as silent. It **returned late**, and four
narrow lanes were dispatched in parallel. All five verdicts are in, and they
found more than the direct grep pass did. Everything below was folded back.

### The finding that changes the plan: #2114 is already owned

**Open PR #2029 rewrites the exact function this unit planned to change**, and
deliberately leaves the #2114 case closed:

```
+ err.includes("Failed to get D-Bus connection: No such file or directory")
+ ... "System has not been booted with systemd"
+     return { kind: "absent" };
+ return unknown(...)   // "other bus failures stay unknown"

+ test("other bus failures stay unknown — the user manager may be running", () => {
+   stderr: "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS not set",
+   expect(...kind).toBe("unknown");
```

#2114's reporter stderr is `Failed to connect to user scope bus via local
transport...` — the family #2029 is choosing to keep `unknown`.

This invalidated three things at once: "#2114 is a cheap first fix", the
no-collision table, and the whole "do #2114 first" sequence. All three shared
one cause — **nobody checked who already owns `inspectSystemd()`.**

### Corrections applied

| Finding | Where | Fix |
|---|---|---|
| #1527 wrongly excluded (PR #2054 says "Does not close #1527") | `000` | set corrected to 9; method note added |
| The 020 fix snippet **fails open** — with the bus down, systemctl cannot see a foreign unit either | `020` | rewritten to consult the unit file on disk before returning `absent` |
| "#2114 before #2108 phase 2" is preference, not dependency | `040` | retracted; they can land in either order |
| #2108 should outrank #2114 (bigger platform, every reboot) | `010` | accepted; order revised |
| #1049 "no incident" is the wrong test for a silent integrity gap | `010` | accepted as detection-only phase 1 |
| `OcxTool` moves in **WP1 (#2019)**, not WP1b | `050` | corrected |
| #1934 overlaps **all five** of #1587's files | `050` | recorded as the real hazard |
| `tests/tray-windows.test.ts` does not exist | `060` | corrected to `windows-tray.test.ts` |
| `C:\Users\MötzJensen` was reconstructed, not observed | `060` | honesty note; do not close on the inference |

### Rejected, with reason

**"Drop #1933 from the selected set."** Folding it into the Windows pass is
accepted; dropping it is not. The helper already exists and is already wired
elsewhere — a half-applied class fix is how the next site gets missed — and the
GUI offers no repair path, so the affected user is stuck.

### Still open after this round

- **#1527** is unclaimed and **not investigated**. It arrived after the lanes
  were dispatched. The selected set cannot be called final until it is.
- The **#1587 measurement** (95.7%) is a lane result that cannot be replayed
  here. Mechanism confirmed; treat the number as one sample.
- Several **line citations drifted** (`native-main-owner.ts:272` is
  `release()`; the second ACL timeout is nearer `:205`). Verify before quoting.
- Follow-ups this unit names and then drops: `/readyz` ignoring the native-main
  fence, the Codex "at capacity" remap, and the `ocx gui` supervision split from
  #1419 — none has an issue number.

## Note on lane reliability in this unit

Of eleven dispatches, two went silent in the first batch and one audit lane
went silent at the end. That is a meaningful failure rate and it changed how
this unit was built: the surviving evidence is per-issue lane reports plus
direct verification, not a single audited pass. Where a claim rests only on a
lane, this document says so.
