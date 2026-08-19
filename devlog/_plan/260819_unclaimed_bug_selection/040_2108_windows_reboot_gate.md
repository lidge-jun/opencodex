# 040 — #2108: Windows reboot leaves the native-main gate stuck

Rank 3. **This doc deliberately does not prescribe a mechanism fix first.**

## What is confirmed

The 503 is the process-wide native-main fence — same layer as #2114, different
trigger. `/healthz` never consults the gate (`src/server/index.ts:813`), which
is why the reporter sees 200 health + 200 Anthropic + 503 GPT and reasonably
concludes the proxy is fine.

The structural cause is one line of policy:

```
src/server/index.ts:702-710
  owned      -> startNativeMainStartupLifecycle()
  anything else -> blockNativeMainStartupForUnownedServiceHome(...)  // for the process lifetime
```

**`startServer()` takes a one-shot ownership verdict and never retries it.**
That is why waiting does not help and `ocx restart` does.

## What is NOT confirmed, and why that matters

The investigation found two plausible triggers and could not distinguish them,
because **the settled gate reason is never logged**:

1. **Owner ACL fail-closed.** A second `ETIMEDOUT` in icacls hardening is
   terminal — it publishes `{ status: "unavailable", reason: "lock-unavailable" }`
   at `src/codex/native-main-owner.ts:205-212` — and `observeOwner()` settles to
   `owner-unavailable` and stops (`native-profile-startup.ts:225-236`). The ACL
   module's own comment already describes this exact symptom. Timing fits: the
   first 503 is ~74s after wrapper start, past the ~60s owner budget.
2. **Probe fail-closed.** `SERVICE_PROBE_TIMEOUT_MS` is 2000ms. A
   scheduler-only install still runs `sc.exe query` for WinSW; if that times out
   with WinSW assets absent, `walkWinswChain()` returns `unknown` rather than
   `absent` (`service-manager-probe.ts:732-736`).

**Line numbers matter here.** An earlier draft cited `native-main-owner.ts:272`,
which is `if (released) return` inside `release()` — a fixer grepping that line
lands in the wrong function entirely.

Two readings were **disproved** and should not be re-raised: the
"did not shut down cleanly" line is the injection journal
(`src/codex/journal.ts:209`), not the native-profile journal; and disk
`manual-recovery` residue would survive `ocx restart`, which contradicts the
reporter's own observation that restart cures it.

## Phase 1 — log the reason (do this first, alone)

Emit the concrete gate reason when the fence settles and when the 503 is
returned (`src/codex/auth-context.ts`, `src/codex/native-profile-startup.ts`).

This is not a placeholder task. Without it the next reboot report is exactly as
ambiguous as this one, and we will be guessing between the same two candidates.
A shipped diagnostic converts the next occurrence into evidence.

**Test:** the 503 log line includes the settled reason.

## Phase 2 — make boot-time `unknown` retryable (after phase 1 has data)

Treat `unknown` that came from a *timeout or unaskable manager* as retryable
while `OCX_SERVICE=1`, instead of a process-lifetime fence. Keep genuine
`foreign` fail-closed, and keep a retry cap.

Two narrower fixes fall out and are worth doing regardless:

- If WinSW xml **and** exe are absent, a timed-out `sc.exe query` must not mark
  the machine `unknown`.
- A second ACL `ETIMEDOUT` on the service child should back off and retry rather
  than settle terminal, so a warm icacls reopens the gate without `ocx restart`.

## Tests that are currently green and encode the bug

| Test | Asserts today |
|---|---|
| `tests/native-main-owner-lifetime.test.ts` | second `ETIMEDOUT` → terminal `unavailable` |
| `tests/codex-service-manager-probe.test.ts` | schtasks timeout → `unknown` |
| `tests/native-profile-startup.test.ts` | `ownership-unknown` blocks for the process |

## Collision with open work

**PR #2101** (`fix(codex): gate account-native models by entitlement`, 1397
lines) already edits `src/server/index.ts` and `src/codex/auth-context.ts` —
both files phase 1 and phase 2 touch. Check its state before starting; the
reason-logging change in phase 1 is small enough to be folded in rather than
raced.

A red-today regression: `startServer` on win32 with scheduler assets present,
first probe timed out and/or two owner ACL timeouts, then a later successful
probe in the **same** process — `POST /v1/responses` for a native model must go
503 → 200 without `process.exit`. Keep a control that a real foreign home stays
503.

## Verification

```
bun test tests/native-profile-startup.test.ts tests/native-main-owner-lifetime.test.ts tests/codex-service-manager-probe.test.ts
bun x tsc --noEmit
```

Windows CI is authoritative here; a green macOS/Linux run proves little about
scheduler and icacls paths.

## Sequencing note — corrected

The first version of this section said "do #2114 first" and called it a
dependency. **An audit lane refuted that, and it was right.** The two fixes
touch different seams:

- #2114 narrows one Linux classification in `inspectSystemd()`.
- #2108 phase 2 changes *fence policy* — a one-shot `unknown` becomes
  retryable.

Neither needs the other. #2114 does not implement retryability; phase 2 does not
classify the systemd bus. The shared `unknown → permanent fence` chain is a
shared *symptom*, and the overlap in `service-manager-probe.ts` is merge
convenience, not a prerequisite.

So: **they can land in either order.** The preference for #2114 first was
"don't design the general rule from the instance we understand least", which is
a reasonable working habit and not a constraint. Stated as a dependency it
would have delayed the Windows fix for no technical reason.

The one real ordering constraint here remains internal: **phase 1 before phase
2**, because the trigger is unidentified and phase 2 aims at one of two
candidates.
