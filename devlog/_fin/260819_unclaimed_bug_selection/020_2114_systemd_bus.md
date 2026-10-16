# 020 — #2114: native-main 503 when systemctl exists but the user bus does not

**FIRST ACTION: extend or rebase open PR [#2029], do not open a parallel PR.**

Starts after stage 3d of `260819_next_roadmap/070`.

## This is not greenfield work — #2029 already owns this function

An audit lane caught what the candidate filter could not: the filter asked
"does an open PR mention issue #2114", and the answer was no. It never asked
"does an open PR already edit `inspectSystemd()`", and the answer to that is
**yes**.

```
PR #2029  fix(probe): classify a missing user session bus as absent
          reviewDecision: CHANGES_REQUESTED
          files: src/service-manager-probe.ts, tests/codex-service-manager-probe.test.ts
```

#2029 fixes #1939 by classifying two D-Bus messages as `absent`, and
**deliberately keeps** `Failed to connect to bus` → `unknown` — which is
exactly the pin #2114 needs changed. It is blocked on a review objection that
this document independently rediscovered and wrote down as "test 3": a missing
bus is not proof that the unit file is absent, so a naive widening fails open
when a foreign unit is still on disk.

So #2114 and #1939 are **one probe-policy decision with two user-visible
symptoms** — a refused sync (#1939) and a native 503 (#2114). Treating them as
two units means two people making the same fail-closed security-adjacent call
in two PRs, with the second one silently overwriting the first.

**Consequence for ranking:** the work is real and still first, but it is
"unblock #2029 by supplying the containment its reviewer asked for", not "open
a new PR". The container/foreground gate below is the shape of that answer.

## Failure mechanism

> **STOP — read this before planning any work on this issue.**
>
> **Open PR #2029 already rewrites `inspectSystemd()`'s non-zero branch**, and
> it deliberately keeps the #2114 case as `unknown`. This doc was written as if
> that function were unowned. It is not.
>
> What #2029 actually does:
>
> ```
> +  err.includes("Failed to get D-Bus connection: No such file or directory")
> +  ... "System has not been booted with systemd"
> +      return { kind: "absent" };
> +  return unknown(...)   // "other bus failures stay unknown"
> ```
>
> and it adds a test that **cements the #2114 shape as `unknown`**:
>
> ```
> +  test("other bus failures stay unknown — the user manager may be running", () => {
> +    stderr: "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS not set",
> +    expect(...kind).toBe("unknown");
> ```
>
> The #2114 reporter's stderr is
> `Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined`
> — which is exactly the family #2029 is choosing to leave closed.
>
> **Consequence: this is not a fresh patch, it is a conversation with #2029.**
> Either extend that PR's classifier to cover this stderr family, or land it and
> follow up on the same branch. Opening a competing PR means two changes fighting
> over one function, and the later one may silently re-pin the bug.
>
> This also changes the ranking: a fail-closed probe change is not "cheap" when
> an overlapping PR is already open on it. See `010`.

```
src/service-manager-probe.ts:267        if (shown.spawnFailed) return { kind: "absent" };
src/service-manager-probe.ts:269-272    if (shown.status !== 0) { ... return unknown(...) }
```

(:269 is the `if`; the `return unknown(...)` is :272.)

The comment on :270 says a non-zero status means "the question never reached the
bus" — which is exactly right, and is exactly why returning `unknown` is wrong.
A question that never reached the bus is evidence about the bus, not evidence
that a foreign service owns this home.

From there the verdict is terminal for the process:

| Step | File |
|---|---|
| `manager.kind === "unknown"` → `ownership: "unknown"` | `src/integrations/native/ownership-preflight.ts:155` |
| not `owned` → `blockNativeMainStartupForUnownedServiceHome("ownership-unknown")` | `src/server/index.ts:702-708` (:702 is the probe call, the block is :706) |
| snapshot blocked → `isNativeMainTrafficBlocked()` true | `src/codex/native-profile-startup.ts:351` |
| throws `CodexMainProfileDrainingError` | `src/codex/auth-context.ts:313`, `:318` |
| 503 `OpenCodex local native-main profile maintenance is active` | `src/codex/auth-context.ts:125-126` |

## Why the existing #1612 fix does not cover it

`bb45902ef` mapped **spawn** failure to `absent` — `systemctl` missing from
PATH. Here spawn succeeds and returns exit 1 with
`Failed to connect to user scope bus via local transport`. Same user-visible
outcome, different branch.

## Fix shape

**Primary change: one classification branch in `inspectSystemd()`.**

Match bus-unreachable stderr specifically rather than widening every non-zero
exit, and gate the widening on an environment that already cannot host a user
service. The product already owns that signal and does not pass it to the
probe: `service.ts:3122` refuses service install when `/.dockerenv` exists and
reports `unsupported in Docker`.

```
if (shown.status !== 0) {
  if (busUnreachable(shown.stderr) && deps.serviceHostingUnsupported()) {
    return { kind: "absent" };
  }
  return unknown(...)   // unchanged for every other case
}
```

Thread the signal through `ProbeDeps` — the probe is already injectable
(`ProbeRunner`, `ProbeDeps`), so there is no call-site churn.

### That snippet is unsafe as written — corrected

An audit lane found the flaw and it is the important finding of this doc.
**With the bus down, `systemctl` cannot see a foreign unit either.** The
snippet returns `absent` on stderr + container signal alone, with no other
ownership evidence. A temporary bus outage inside a container that *does* host
a user service is exactly the fail-open the risk section warns about — and
test 3 below asserts a behavior the code shape cannot deliver.

The classification must consult the **filesystem**, which does not need the
bus:

```
if (shown.status !== 0) {
  if (!busUnreachable(shown.stderr) || !deps.serviceHostingUnsupported()) {
    return unknown(...);            // unchanged for every other case
  }
  // The bus could not answer. Ask the disk instead: a unit file is proof of
  // installation that does not require a running bus.
  const unit = deps.readUnitFile?.(UNIT_PATH);
  if (unit === undefined) return { kind: "absent" };   // no unit, no owner
  return unitOwnershipFrom(unit);                      // foreign stays foreign
}
```

`inspectSystemd()` already parses `FragmentPath` for the bus-answered path, so
the unit-file reader and the "does this unit name our home" logic exist in some
form; this reuses them on the offline path rather than inventing a second
notion of ownership.

**Open decisions the implementer must make, which this doc cannot make for
them:**

- `serviceHostingUnsupported()` **does not exist**. `service.ts:3122` is an
  *install-time* `/.dockerenv` check. Whether the probe signal is Docker-only
  or the broader "container/foreground" the risk section mentions is unset —
  and it matters, because Podman and Kubernetes often have no `/.dockerenv`.
- `busUnreachable()` does not exist, and the locale policy is unchosen: match
  strings, ignore stderr entirely, or force `LC_ALL=C` on the probe.
- The unit path constant and reader are not named here.

**Stderr variants to match.** At minimum
`Failed to connect to user scope bus` and
`$DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined`. #1939 reports a
third shape, `Failed to get D-Bus connection`. Locale sensitivity is a real
weakness of string matching here and should be called out in the PR rather than
papered over; a non-English systemd will not match. If that is unacceptable,
the alternative is to key only on the container/foreground signal and ignore
stderr entirely — narrower, but locale-proof.

**Files:** `src/service-manager-probe.ts`, `src/integrations/native/ownership-preflight.ts`
(signal plumbing only), `tests/service-probe-docker.test.ts`,
`tests/codex-service-manager-probe.test.ts`.

**Coordination:** those are the same two files #2029 already changes. Rebase on
it or fold this into it; do not race it.

## The test that must change, deliberately

`tests/codex-service-manager-probe.test.ts:277` currently asserts
`status: 1, stderr: "Failed to connect to bus"` → `unknown`. **Amend it, do not
delete it**: keep that assertion for the non-container case, so the widening
stays honest.

## Regression tests

Red today, green after:

1. Container signal set + `systemctl` spawn ok + exit 1 bus error + no unit
   file → `{ kind: "absent" }` → `inspectNativeCodexOwnership` `owned` →
   native-main not blocked.

Must stay red (guards against over-widening):

2. Same stderr, **no** container signal → still `unknown`.
3. Container signal + an installed unit naming a foreign home → still blocked.

A `startServer` test injecting that probe result should return 503 today and
200 after.

## Verification

```
bun test tests/service-probe-docker.test.ts tests/codex-service-manager-probe.test.ts
bun x tsc --noEmit
```

## Risk

This is a **fail-closed security-adjacent boundary**. The failure mode of a bad
fix is admitting native-main on a host where a genuinely foreign unit exists but
was temporarily unqueryable. The container/foreground gate plus test 3 is what
keeps that closed. Do not widen all non-zero exits.

**Correction:** the container gate alone does *not* keep that closed — that was
the audit's finding above. The disk check is what keeps it closed; the
container gate only limits where the offline path is taken at all.

**Coverage limit to state plainly.** Even corrected, this fix only relieves
hosts that hit the container signal. WSL without `systemd=true`, bare SSH
sessions with no `XDG_RUNTIME_DIR`, CI runners, and Podman/k8s without
`/.dockerenv` keep returning `unknown` and keep 503-ing. If those matter, the
answer is #2108 phase 2's retryable fence, not a wider classifier here — which
is an argument for doing that work regardless of this fix.

## Explicitly out of scope

Two secondary bugs surfaced in the same thread. Both are real; neither should
ride this fix:

- `ocx ready` / `/readyz` ignores `isNativeMainTrafficBlocked()`
  (`src/server/index.ts:850`), so readiness can read ready while every native
  request 503s.
- Codex CLI renders the local 503 as "Selected model is at capacity", because
  the code is remapped to `server_is_overloaded` (`src/lib/errors.ts:229`).
  The body is correct; the user-facing sentence is not.
