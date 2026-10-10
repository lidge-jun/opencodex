# Contradiction round 2

Run after the four decisions were made: ask-once permanent takeover, keep the npm registration and
record an owner, per-user by default with elevation only at the point of failure, all three
platforms. Two lenses, 11 contradictions, 6 high. The weakest dimension going in was success
criteria, and that is where most of them landed.

## Nothing here is observable yet

- **"Ask once, then own permanently" has no durable state.** Ownership is recomputed each launch
  from whether this process spawned a child; service state has no owner field and no consent field.
  A restart can silently demote the app back to guest and no test would see it.
- **"Keep the registration, supersede it" has no marker either.** State records a launcher path and
  a backend, and repair still prefers the recorded launcher. There is nothing to write the decision
  into and nothing to assert against.
- **The quit criterion is currently inverted on macOS and undefined elsewhere.** Tray Quit calls
  `app.exit`, `RunEvent::Exit` calls `shutdown_child`, and that kills the child. Windows and
  Linux have no Cmd+Q equivalent named anywhere, so they could be called compliant without proving
  the runtime survived their equivalent gesture.
- **No check observes an installed app taking over a real runtime.** Desktop CI builds against a
  zero-byte sidecar; lifecycle CI installs a service from a source checkout and never stages an npm
  install to hand over.

## The dialog defect reaches further than one button

- `stop-proxy.ts` treats *every* fetch exception as acceptance, so a failed stop and a successful
  one are already indistinguishable before the missing alert.
- `window.prompt()` is used for alias editing on the provider and model pages. wry implements no
  text input panel either, so those edits cannot be made in the app at all.
- Account, key, model, routing and tray-uninstall changes are all gated the same way. AGENTS.md
  requires identity-affecting actions to sit behind an explicit gate; inside the app that gate
  cannot be passed, so the action fails safe but also fails silently.

## Two things that make this cheaper than it looks

- **The fix already exists in the tree.** `OAuthTosWarningModal` and `ConsequenceDialog` are
  in-page `<dialog>` components with real consent flows. The dashboard does not need a platform
  dialog; it needs to stop using one.
- **The shell is already detectable.** `gui/src/lib/desktop-shell.ts` exists and is used today
  only to reroute external links, so there is a seam to branch on if a branch is wanted rather than
  a straight replacement.

## Why CI could never have caught it

The existing GUI tests encode browser dialogs as available. `codex-stale-banner-dom.test.tsx`
stubs `confirm()` to true and `alert()` to a no-op; `memory-observability-card.test.tsx` forces
confirmation; `app-stop.test.ts` asserts that `alert()` *exists*. Each of those is reasonable on
its own and together they make the desktop failure invisible. A regression test for this has to
assert the absence of platform dialogs, not stub them in.

## Open assumptions carried forward

1. The Linux box has no npm `ocx`, so the coexistence scenario has to be staged there before it
   can be exercised.
2. `.deb` and AppImage are one "Linux" in the charter but two update contracts; the manifest
   names AppImage only.
3. "Cmd+Q keeps it in the menu bar" has no literal equivalent on Windows or Linux. The portable
   statement is that closing a window and quitting the app are different actions, and only the
   explicit tray Quit ends the runtime.
4. Whether the takeover consent becomes an in-page dialog or the shell gains the delegate methods
   is a plan decision, not an interview one.

