# 130 — What the installed Linux build actually does

Follow-up to 120, after the desktop shell landed. Same machine described by role: a GNOME
workstation on an X11 session with no tray host, and a user-level npm install of the proxy already
holding the default port.

## The no-tray case is fixed

Before the shell landed, the installed app ran with no window and no tray icon — alive and
unreachable. With the shell in the tree, the same machine shows a real window: an X client
enumeration lists an `OpenCodex` window at 1100x720 alongside the session's own windows. That is
D6 doing what it was written to do, now observed rather than argued.

The runtime already on the port was left alone throughout: `/healthz` reported the same pid and
version before, during and after every run, and no install-state record was written. Takeover is
gated on consent, so that is the expected shape for this tree.

## The startup surface never runs on Linux

The window renders, and then nothing happens. The headline stays on the markup's default, the phase
checklist stays empty, and no terminal state is ever reached. The page's JavaScript does not execute
at all.

Narrowing it took four builds, and the order matters because three plausible causes were eliminated
by measurement rather than by reading:

1. **The asset is served correctly.** A probe that fetches the script from the page sees
   `status=200`, `content-type: text/javascript`, 5941 bytes. Not a missing asset, not a MIME
   refusal.
2. **Inline script runs when the policy is removed.** With the configured `csp` deleted, an inline
   probe paints immediately, and the page's own script runs to completion: the checklist renders,
   the registration phase completes, and the resolve phase becomes active.
3. **Widening the policy does not help.** Naming the asset-protocol scheme and host in `script-src`
   changed nothing.
4. **Neither does `'unsafe-inline'`.** This is the informative one. `'unsafe-inline'` is ignored when
   a nonce or a hash appears in the same directive, so the policy the webview enforces is not the
   policy in the configuration file — the directive is being rewritten into a form that admits
   neither the page's script nor an inline one.

The dashboard is unaffected because it loads from the proxy's loopback origin and carries that
origin's own headers. Only the embedded bootstrap page is dead, which is why the product looks fine
until the moment it has to explain itself — and a startup surface that cannot report is exactly the
failure class this unit exists to close.

Raised as its own issue with the evidence chain, and handed to the desktop lane. The fix has to
admit the script legitimately rather than remove the policy, so it is a design decision about how
the embedded page is served, not a widening of sources.

## Two defects fixed on the way

Both were found by looking at the screen and then confirmed in source, and both landed.

**The failure block ignored its own `hidden` attribute.** An id rule with `display: grid` outranks
the user agent's `[hidden] { display: none }`, so the Retry button and an empty read-only diagnostic
box were painted during every normal start, under a headline that still said the runtime was
starting. That is precisely the screen a user reads as a dead application with one button. Removing
it is visible in the before/after captures from the same machine.

**The page had no deadline of its own.** `invoke` returns a promise that neither settles nor rejects
when the command never answers, so the page could sit on its first handshake forever while the
shell's own deadline ran somewhere the user could not see. The handshake is now bounded and a
timeout is reported through the existing failure path.

## Status

- Linux deb: built, installed, launched, and inspected on a real session.
- Window presence with no tray host: VERIFIED.
- Existing runtime left undisturbed: VERIFIED.
- Startup surface reporting on Linux: FAILS — open issue, not closed by this unit.
- Windows: the verification machine required disabling its application-control policy before the
  toolchain could build at all; that is recorded separately.
- Repository suites, typecheck and builds of the repository itself: NOT RUN, per the batch rule.
