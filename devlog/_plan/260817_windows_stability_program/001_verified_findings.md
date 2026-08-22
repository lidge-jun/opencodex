# 001 — Verified findings

Every entry below was reproduced against the working tree at `474584bcd` on
2026-08-17. Line numbers are from that tree. Findings the audits raised that
could not be reproduced are listed at the bottom under "Not carried".

Ranked by user impact.

---

## F1 — `src/service.ts:2361` uses the exact PowerShell argv the codebase forbids

`killWindowsServiceWrapperProcesses()` in `src/service.ts` spawns:

```ts
// src/service.ts:2360-2363
spawnSync(resolveTrustedWindowsPowerShellExe(), [
  "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden",
  "-Command", ps,
], { stdio: "ignore", timeout: 5000, windowsHide: true });
```

The codebase already knows this is wrong. `src/codex/user-identity.ts:222-224`:

> Do not add PowerShell's `-WindowStyle Hidden` here: Bun 1.3.14 can fail that
> direct CLI combination before the SID command executes (#1589); the
> process-level `windowsHide` flag is sufficient.

**Why it survived.** The regression test is scoped to one file:

```ts
// tests/windows-deploy-close-regressions.test.ts:43
expect(src).not.toContain('["-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps]');
```

`src` there is `read("src/update/job.ts")` (line 13). `src/service.ts` is never
checked. A search of `src/` finds exactly one surviving production occurrence
of that CLI pair: `src/service.ts:2361`.

**User-visible consequence.** `stopServiceIfInstalled()` calls this function
because `schtasks /end` can leave the `wscript.exe`/`cmd.exe` wrapper alive,
which then respawns the proxy. The call ignores `spawnSync`'s exit status and
swallows errors, so under #1589 wrapper termination silently does nothing:
`ocx stop`, restart, and update appear to succeed and do not stick.

Severity: high. Fix cost: one line. Phase 010.

---

## F2 — The wrapper killer exists twice and the copies have drifted apart

Two implementations of the same operation:

```ts
// src/service.ts:2337-2358 — canonical token matching scoped to THIS home
//   (paths built 2340-2341; token boundaries enforced 2350-2355)
// src/update/job.ts:1377-1383 (the bare -like match is line 1383)
"$pats = @('opencodex-service.cmd','opencodex-service-launcher.vbs');"
...
"foreach ($p in $pats) { if ($c -like ('*' + $p + '*')) { return $true } };"
```

The updater copy matches a bare filename anywhere in a command line. Two
OpenCodex homes under one Windows account means a dashboard update for home A
can terminate home B's scheduler wrapper. Any unrelated process whose command
line contains either filename also matches.

Cited precisely: the updater's bare match is `src/update/job.ts:1383`; the service copy builds canonical paths at `src/service.ts:2340-2341` and enforces token boundaries at `:2350-2355`.

The drift is already measurable and runs in both directions: `update/job.ts`
received the #1589 argv cleanup that `service.ts` missed (F1); `service.ts`
received canonical path scoping that `update/job.ts` missed. Two copies, two
different half-fixes.

Severity: high (cross-installation process kill). Phase 020.

---

## F3 — Windows is not a gate, and the release gate cannot see that

```yaml
# .github/workflows/ci.yml:547-552
if: github.event_name == 'workflow_dispatch'
```

The aggregation job accepts `skipped` (`ci.yml:769-772` — the jq filter keeps
only jobs that are neither `success` nor `skipped`). The release preflight
(`release.yml:181-201`) demands a successful **push-event** `ci.yml` run —
deliberately narrower than "any successful run for this SHA" — but
`platform-windows` never runs on push. So the general release preflight does not require `platform-windows`, and a
release can publish without it having run.

One qualification, because the stronger claim is not true: releases that touch
`src/service.ts`, `src/cli/index.ts`, `package.json` and a few others separately
require a green `service-lifecycle.yml` (`release.yml:224-241`, enforced at
235-239), and that
workflow does include a Windows job. Windows is therefore not entirely absent
from release gating - it is absent from the *suite* gate, and present only as a
lifecycle smoke test for service-shaped changes.

Severity: high, and it is the multiplier on every other finding — without it,
each fix below is one careless merge away from regressing. Phases 060 and 070.

---

## F4 — Durable publishers do not share the Windows retry primitive

`src/config.ts:102-123` knows about Windows sharing violations:

```ts
const transientWindowsError = io.platform === "win32"
  && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
if (!transientWindowsError || attempt >= 2) throw error;
io.sleep(25 * (attempt + 1));
```

Two retries, 25ms then 50ms: about 75ms of total tolerance. Other durable
publishers do not call it at all and use raw `renameSync`:

- `src/codex/prompt-journal.ts` — publishes a journal holding full
  `config.toml` bytes
- `src/lib/config-ownership.ts` — publishes the uninstall ownership manifest

These are fail-safe, not corrupting: they throw rather than publish a partial
file. But under a real-time scanner or a sync client holding the target, they
turn a recoverable hiccup into a user-visible operational failure.

The 75ms envelope is itself a watch item, not yet a defect — we have no field
telemetry showing Defender or OneDrive holding files longer. Instrument before
widening. Phase 030 makes the primitive shared; Phase 031 adds the counters.

---

## F5 — `chmod` is load-bearing where it does nothing

`src/config.ts` calls `chmodSync(target, 0o600)` at lines 221, 316, 450, 1713,
2683 and 3942, and `chmodSync(dir, 0o700)` at 1704, 2632, each wrapped in
`catch { /* platform may ignore chmod */ }`. The 3942 site sits inside
`backupInvalidConfig` (declared at 3937), which copies the whole config
including whatever secrets it held. On Windows the call is a no-op:
the ACL is what protects the file, and `src/lib/windows-secret-acl.ts` is what
sets it.

Where both run, the file is protected. The audit work needed here is an
inventory: every path that writes a credential, token, or OAuth refresh token,
and whether the Windows ACL path is reached on that specific write or only the
`chmod`. `src/service.ts:1983` states the ACL is authoritative, but says so about an
elevation staging directory specifically. That is evidence for the principle,
not evidence about any credential writer's coverage - each inventory row needs
its own citation.

Treated as **unproven** until the inventory is done. Phase 040. Per AGENTS.md,
if that inventory turns up a live exposure the writeup goes to scratch space,
not into this directory.

---

## F6 — The service wrapper retries a deterministic crash forever

```bat
:: src/service.ts:1556-1563
"%OCX_BUN%" "%OCX_CLI%" start ...
if %ERRORLEVEL% NEQ 0 (
  ... restarting in 5s
  ping -n 6 127.0.0.1 >nul
  goto loop
)
```

A proxy that starts successfully and then crashes deterministically is
relaunched every five seconds indefinitely. #1877 deliberately fixed only the
missing-executable case, on the reasoning that a flat "N failures then stop"
ceiling would break recovery from intermittent faults. That reasoning is sound;
the conclusion does not have to be an unbounded fixed-interval loop.

Capped exponential backoff with a health-reset — 5s, 15s, 30s, 60s, reset after
sustained uptime — preserves recovery and stops the log storm. Phase 050.

---

## F7 — Windows CI never proves crash-restart

`.github/workflows/service-lifecycle.yml:104-135` kills the systemd MainPID,
waits for a different PID, and asserts `/healthz`. The Windows job
(`windows-schtasks`, line 239) only covers install, health, clean `ocx stop`,
uninstall. The restart path F6 describes has no coverage on the platform where
it is implemented in batch. Phase 051.

---

## Not carried

Raised by the audits, deliberately excluded:

- **#1843 elevated `Start-Process` argv** — already fixed; PR #1860 merged and
  present in the tree.
- **#31 passthrough SSE segfault** — fixed via `body.tee()`.
- **Bun replacing its own running executable during update** —
  `src/update/index.ts:152-155` documents that the plain-Node launcher handles
  npm self-update before Bun starts.
- **Synchronous `icacls`/CIM on the request path (#1852, #1298; PR #1876)** —
  both P1 and P3 rate this their top runtime issue and the reasoning is
  persuasive, but it is a latency property this session did not measure. It
  belongs to the open PR, not to this unit. Recorded here so the next cycle
  starts from it rather than rediscovering it.
