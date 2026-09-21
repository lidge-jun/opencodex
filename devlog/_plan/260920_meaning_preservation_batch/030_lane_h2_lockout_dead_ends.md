# Lane H2 — the remaining Codex lockout dead ends (#5261)

Status: OPEN. Base is `origin/dev` at `043aa435ff`, after lane H landed as `9880c3cad2`.
One branch, ordered commits, one pull request to `dev`.

Lane H removed the dead end a locked-out user hits: injected routing now names its own undo,
a dead proxy is told to say so, and there is a troubleshooting page. This lane takes the four
paths INTO that state which lane H listed as not closed.

## Why these four belong together

None of them locks anyone out alone. Each one removes a signal, and the incident is what
happens when all of them are missing at once: a proxy that stopped, an autostart that failed
silently, a reboot that restarted nothing, a catalog pointer left naming a deleted file, and an
account flow that looked like it was working. Every individual step had an explanation; the
user had no way to reach any of them.

## 1. The shim hid autostart failure, and could prevent Codex launching

The wrapper ran `ocx ensure` with both streams discarded and `|| true`, then launched Codex
regardless (`src/codex/shim-templates.ts:139`). A failed start was invisible.

Ensure's own streams stay discarded rather than being let through. It prints progress and
warnings on exit-zero runs too, so a wrapper that leaked them would put noise in front of every
ordinary launch, which is how a diagnostic gets ignored. The exit status is the signal.

PowerShell had the opposite defect in the same place: a throwing `ensure` escaped a `try/finally`
with no `catch`, so Codex never launched at all. The autostart helper was producing the exact
lockout it exists to prevent, and the previous test asserted that propagation as correct
behaviour. It now catches, reports, and hands over.

Not closed: the Unix revision marker moved to 3 so installed Unix shims regenerate, but Windows
shims carry no revision marker and are excluded from obsolete-shim refresh
(`src/codex/shim.ts:892`). Existing Windows wrappers keep the old text until reinstalled. Giving
Windows a refresh path is its own change.

## 2. The catalog pointer — my lane H note was wrong

Lane H recorded that nothing revalidates `model_catalog_json` after injection. That is not true.
The chooser refuses a missing owned path and the caller strips the stale line
(`src/codex/inject.ts:327`), with end-to-end coverage already in place.

The real gap is narrower and worse: that repair only reaches someone who runs opencodex again,
and the difficulty of this state is that Codex is the thing that stopped working, so nothing
prompts them to. A `model_catalog_json` naming a file that is gone does not degrade Codex, it
stops Codex loading its configuration at all — the same blank wall as dead routing, from a
different cause. So this lane adds detection, not repair, and `ocx status` now names the file
and both ways out.

## 3. Reboot: stated, not faked

Applying the integration does not install a service, and the Windows scheduled task a separate
install would create is logon-triggered (`src/service/windows-taskxml.ts:225`). Setup ended on a
success line without ever saying routing outlives the proxy.

A BootTrigger is deliberately NOT the fix. The task runs as the interactive user
(`LogonType: InteractiveToken`), so before logon there is no session for it to run in; the
trigger would read like a fix and change nothing. Genuine pre-logon start means a different
principal and a different service backend, which is larger than this lane and is left open
rather than half-done. What was cheap and true on every platform is saying the dependency
exists, reusing the health model `ocx status` and `ocx doctor` already report.

## 4. Account pool: a silence, not an error

The URL launcher swallowed its own failure and returned nothing, so the Codex login route
answered identically whether a browser opened, failed, or was skipped. The CLI printed the URL
and polled, and a user whose machine could not launch a browser watched something that looked
like it was working.

Launch failure is now reported and never fatal — the URL is still worth opening by hand and the
flow stays live. The CLI names the fixed callback port 1455, because ChatGPT supplies the
redirect URI and the flow cannot move to a free port, so `--device` is the way around it.

Not closed: the dashboard keeps last-good rows after a failed refresh
(`gui/src/hooks/useCodexAccountPool.ts:325`), which is why a newly added account can be absent
while older rows still show. That is a GUI change, and the pull-request gate requires a
screenshot of a UI change, which cannot be produced under this lane's no-build constraint. It
is left for a lane that can build the GUI.

## Verification

Static source review and exact-head hosted CI only. NOT RUN, by lane constraint: local suite,
individual tests, typecheck, build, install, `ocx` execution, service start or restart, and any
change to credentials or configuration on the machine. The incident being fixed is a
configuration change that locked a user out.

Checked before push: the file-size ratchet (no tracked file over cap; `codex-shim.test.ts`
sits close to its cap, so the new shim tests went to a sibling file registered in both
layout maps), and the restated-constant class that broke two lanes in this batch — the shim
test's private literal copies of the marker constants now come from the source module.
