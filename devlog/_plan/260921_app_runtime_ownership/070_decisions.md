# Decisions

Settled by the maintainer, then by an automated decider round in which each fork was given to an
independent reader with the evidence and the trade-offs and asked to choose one option and own its
cost. Each entry records the choice and the cost that was accepted with it, because the cost is the
part a later reader will want.

## Fixed by the maintainer

| | decision |
| --- | --- |
| Takeover | Ask once on first discovery of an existing npm runtime. On approval the app is the permanent owner. |
| The npm install | The user's service registration is kept, never deleted. A durable owner marker supersedes it and repair and update must respect it. |
| Elevation | Per-user by default. Elevate only at the point a per-user operation actually fails, which is what the Windows path already does. |
| Platforms | macOS, Windows and Linux, with a verification machine for each. |
| Quit | Cmd+Q leaves the app in the menu bar with the runtime alive. |

## D1 — the consent and feedback surface

**Every platform dialog leaves the dashboard.** `confirm`, `alert` and `prompt` are removed
from `gui/src` and replaced with the in-page dialog and feedback components already in the tree,
with a source guard so they cannot come back.

The decider checked the other two platforms rather than assuming: wry leaves WebView2's script
dialog setting untouched and WebView2 enables script dialogs by default, and WebKitGTK shows
dialogs through its default handler. So implementing the macOS delegate would repair one platform
and leave the product's consent UI platform-dependent. **Cost accepted:** the macOS shell still
cannot draw an accidental future platform dialog, so repository code has to keep enforcing the ban
statically.

## D2 — what ends the runtime

**Window close and the OS quit gesture both hide to the tray, on all three platforms. Only the
explicit tray Quit ends the app**, and that path drains an app-owned runtime before exiting.

Observable per platform: close and Cmd+Q on macOS, close and Alt+F4 on Windows, and the window
manager's close on Linux all leave the window hidden with both pids alive and the window
reopenable from the tray; tray Quit drains in-flight work and then ends both. **Cost accepted:**
on a Linux desktop with no tray this strands the user — which is D6.

## D3 — where ownership lives

**Both records, with the shared service state authoritative.** The service install state gains an
owner, an install id and a consent generation, written compare-and-swap and preserved by every
writer; the app keeps its own install identity so a reinstalled app can tell its own prior consent
from another installation's.

The decider rejected the single-record option for a specific reason: an install id stored only in
the shared record gives the app no independent value to compare against, so a reinstalled app
cannot tell whose consent it inherited. **Cost accepted:** two records mean mismatch and orphan
recovery, and losing app-local state can force explicit re-consent, because the two writes cannot
be one atomic act.

## D4 — how an existing managed runtime is stopped

**The app shells out to its own bundled `ocx stop`.** The receipt-backed teardown, the drain, the
Windows respawn verification and the client-configuration restore then run exactly as they do from
a terminal, and the shell reads the exit code and the output.

The alternatives were disqualified by the same fact: launchd and systemd can terminate the request
handler during self-unload, and the Windows respawn window can only be verified after that process
exits, so an in-process management endpoint cannot own its own teardown. **Cost accepted:** the
takeover path now depends on spawning a CLI and surfacing a human-readable result rather than a
structured one.

## D5 — how the shell resolves the port, the home and liveness

**It stops resolving them.** The shell asks the bundled CLI through a machine-readable resolve
command, with a strict timeout, and if the binary is slow or missing it opens a local recovery UI
and refuses to guess a home, a port or a liveness verdict.

The reason is in the comments of the code it would otherwise duplicate: the tuned probe budgets in
the liveness path exist because small divergence produced duplicate proxies, twice. **Cost
accepted:** every launch pays one bounded process start, and startup now depends explicitly on the
bundled binary being executable — which is also why D7's recovery window has to exist first.

