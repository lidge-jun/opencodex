---
title: Codex Cannot Sign In or Load
description: What to do when Codex fails at sign-in or every request errors after opencodex was applied, and how to hand Codex back to its own account without starting the proxy.
---

If Codex stops at a sign-in screen, reports that it cannot load sign-in
requirements, or fails every model request after you set up opencodex, the most
likely cause is that Codex is still pointed at the opencodex proxy while the
proxy is not running. This was reported as
[#5261](https://github.com/lidge-jun/opencodex/issues/5261).

## Why this happens

On the default loopback setup, opencodex does not give Codex a separate
provider. It points Codex's own built-in `openai` provider at the proxy, by
writing a root override into `$CODEX_HOME/config.toml` (`%USERPROFILE%\.codex`
on Windows):

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex (undo: ocx restore)
openai_base_url = "http://127.0.0.1:10100/v1"
# Auto-injected by opencodex (undo: ocx restore)
experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"
```

Those lines are on disk, so they survive a reboot. If the proxy is not running
when Codex starts, that address answers nothing, and Codex has no second
endpoint to fall back to. The screen you get says nothing about opencodex,
which is why the state is easy to misread as a Codex problem.

The proxy can be absent for ordinary reasons. Applying the Codex integration
does not install a background service — that is a separate `ocx service install`
step — so after a restart there may be nothing to bring the proxy back. A
registered Windows scheduled task starts at logon rather than at boot, and it
can also be disabled, fail to launch, or lose the port to another process.

## Get Codex working again

Pick whichever outcome you want. Both are safe to run while the proxy is down.

**Hand Codex back to its own account and endpoints:**

```bash
ocx restore
```

This removes the injected routing, the realtime override and the opencodex
catalog pointer, and needs no running proxy, no dashboard session and no
network. Codex signs in and runs normally afterwards. When you want opencodex
back, `ocx restore back` re-points Codex at the proxy.

**Or bring the proxy back instead:**

```bash
ocx start
ocx service install   # keep it running across restarts
```

`ocx status` reports whether the proxy is answering and whether Codex is
currently routed through it. `ocx doctor` explains the same state in more
detail and names the repair it recommends.

## If ocx is not available

You can undo the routing by hand. Open `$CODEX_HOME/config.toml` and delete
three things: the `openai_base_url` line, the
`experimental_realtime_ws_base_url` line, and any `model_catalog_json` line
ending in `opencodex-catalog.json`. Remove the
`# Auto-injected by opencodex` comment sitting directly above each of the first
two along with them.

Go by the key name, not by the comment. opencodex uses the same ownership
comment above other keys it manages, such as an injected
`developer_instructions`, and deleting those will not help you sign in while
costing you configuration you may want back.

Repeated standalone ownership comments do not change TOML values or routing.
Provider-table reinjection and removal consume the exact bare marker or its
`(undo: ocx restore)` form immediately above `[model_providers.opencodex]`.
Marker text inside another user comment or a multiline string is preserved;
existing comments separated from the table are not claimed by that transform.
Root routing ownership uses an exact adjacent marker at a structural root
assignment. A matching injected value recorded in the journal also proves
ownership after a Codex app rewrite drops comments. Quoting the marker in a
user comment or a multiline string does not prove ownership. Managed
`web_search` replacements record the complete original assignment, including
multiline values, so switching it back on or fallback restore can put it back.
Removal and capture validate complete assignments without converting a valid
64-bit integer into a JavaScript number. Value-based ownership still requires
successful value decoding; invalid or incomplete assignments are refused.
Fallback removal compacts document
blank lines outside multiline values, preserving blank lines within those values.

Delete the `model_catalog_json` line **with** the routing, not on its own. A
`model_catalog_json` that names a file which no longer exists makes Codex fail
to load its configuration at all, which looks like the same lockout for a
different reason.

## Accounts that would not add or display

Failures adding accounts to the pool, or added accounts not appearing, are a
separate matter from the lockout above, even when they happen in the same
session. The account pool is served by the proxy's management API, so both the
`ocx account login openai` flow and the dashboard list need a running proxy
before anything else can work. The browser sign-in also returns to
`http://localhost:1455/auth/callback`, a fixed address that cannot move to
another port. If something else holds port 1455, or a browser cannot be
launched, use the device flow instead:

```bash
ocx account login openai --device
```

See [Codex Integration](/guides/codex-integration/) for what the injection
writes and how routing is chosen.
