# 051 — Windows crash-restart coverage in service CI (F7)

**Depends on:** nothing. Crash-restart exists today, so it is testable now —
and testing it *before* 050 changes the timing gives the change a baseline to
be measured against. Land this first if convenient.

## Change

`.github/workflows/service-lifecycle.yml` covers install, health, clean
`ocx stop`, uninstall in the `windows-schtasks` job (line 239). The Linux job
at lines 104-135 does more: it kills the systemd MainPID, waits for a different
PID, and asserts `/healthz` recovers.

Add the Windows equivalent: kill the proxy process the scheduled task launched,
wait for the wrapper to relaunch it, assert a new PID and a healthy `/healthz`.

## What this test does and does not prove

It proves the wrapper relaunches a killed child. It does **not** prove anything
about 050's backoff curve: reverting 050 would leave a fixed five-second loop
that still relaunches, still yields a new PID, still restores health, and this
test would still pass. Do not present it as verification for 050.

Backoff is verified separately in 050 by asserting on the text
`buildWindowsServiceScript()` generates. That is the honest split: this job
covers the runtime behavior, the source assertion covers the timing policy.

A second job could prove the curve by crashing the child repeatedly and timing
the relaunches, but it would be slow and timing-sensitive on hosted runners —
exactly the flake profile 070 exists to prevent. Not proposed here.

## Verify

```powershell
bun run prepush
gh workflow run service-lifecycle.yml --ref <branch>
```

Then confirm the job fails when the wrapper's relaunch branch is deliberately
broken. That is the red-first check that matters, and unlike the backoff
revert, it actually fails.

## Risk

Medium — new CI on a platform about to carry more weight. A flaky crash-restart
job would poison 060. Land it, watch several runs, then let 060 lean on it.
