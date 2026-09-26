---
title: ChatGPT Desktop Send Unblock
description: Keep the ChatGPT desktop app's composer usable when the account's usage quota runs out (macOS, opt-in).
---

When the logged-in ChatGPT account runs out of usage quota, the ChatGPT desktop app greys out
its send button, even for conversations whose model calls opencodex routes to other providers.
This opt-in macOS integration keeps the composer usable. It is off by default.

## What it changes

opencodex runs a local TLS listener for `chatgpt.com`. The app is launched with a Chromium
switch that sends `chatgpt.com` to that listener; every other host, including its subdomains,
keeps its normal route. Requests are relayed to the real `chatgpt.com` with the app's own
credentials, and WebSockets (such as voice dictation) are relayed as well. Nothing is logged or
stored.

Responses are passed through unchanged except for two endpoints:

- conversation metadata (`/backend-api/conversation/init` and the conversation stream): send
  locks caused by usage quota are removed;
- the usage snapshot (`/backend-api/wham/usage`): the "limit reached" gate is opened.

Send locks with any other reason, such as a subscription requirement, are kept, and
`ocx chatgpt status` lists them. Displayed usage (percentages, reset times, banners) is never
changed, and OpenAI's servers still enforce every limit on their own requests.

## Setup

1. Enable the feature in `~/.opencodex/config.json` and restart opencodex:

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   The listener uses the proxy port plus 200 (`10300` by default). Set
   `chatgptDesktop.port` to choose another port.

2. Trust the local certificate authority once. The command asks for your login password, so
   run it yourself:

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   Without this trust the app cannot load account, usage or settings pages. If you use a
   custom opencodex home, `ocx chatgpt status` prints the exact command for your setup.

3. Launch the app through opencodex:

   ```bash
   ocx chatgpt launch
   ```

4. Optional: make normal Dock and Spotlight launches use the route too:

   ```bash
   ocx chatgpt install-watcher
   ```

   The watcher runs each time the app starts. If the app was opened normally while opencodex
   is running, it quits the app right after launch and reopens it with the route. It never acts
   on an app that is already in use, and does nothing while opencodex is not running. The
   command asks for confirmation; `--yes` confirms non-interactively.

## Network setups

No VPN or proxy rules are needed. In the default mode the launch arguments are chosen from the
system proxy each time the app starts:

| Setup | What the app is launched with |
|---|---|
| No proxy | The `chatgpt.com` route only. |
| VPN in system-proxy mode | The route, the system proxy with a direct fallback, and a bypass for `chatgpt.com` only. |
| VPN in TUN mode | The route only; loopback traffic never enters the tunnel. |
| PAC file | The route only. The PAC file may keep `chatgpt.com` on the proxy, so the composer can stay locked, but nothing else breaks. |

opencodex reaches the real `chatgpt.com` through its own `proxy` setting, like all its other
outbound traffic.

## Keep the app working when opencodex stops

In the default mode a routed app depends on the listener: while opencodex is stopped, its
`chatgpt.com` requests fail. PAC fallback launches the app with a generated PAC file instead, so
the app falls back on its own:

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` only takes effect together with `unblockSend`. opencodex then also listens on the
listener port plus one (`10301` by default) and rewrites `chatgpt-unblock.pac` in its home
directory at every start. The PAC sends `chatgpt.com` to opencodex first, and every other host
the way the system routes it:

| Setup | Other hosts, and `chatgpt.com` while opencodex is stopped |
|---|---|
| No proxy, or VPN in TUN mode | Direct. |
| VPN in system-proxy mode | The system proxy, then direct. |
| PAC file | The system PAC, embedded in the generated file. |

When opencodex stops, the app keeps working on that route without a restart; only the send
unblock pauses until opencodex is back. The route is captured when opencodex starts: after
changing the VPN mode, restart opencodex and run `ocx chatgpt launch`. If a system PAC is set but
cannot be read at that moment, other hosts go direct and opencodex prints a warning.

After turning `pacFallback` on or off, restart opencodex, run `ocx chatgpt launch`, and run
`ocx chatgpt install-watcher` again if you use the watcher.

## Check the state

```bash
ocx chatgpt status
```

It reports whether the feature is on, whether the listener on the port is opencodex's, whether
the certificate is trusted, the watcher state, whether the running app carries the route, and
any send locks that were kept on purpose.

## Turn it off

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore` reopens a routed app with native networking. Then set
`chatgptDesktop.unblockSend` to `false` and restart opencodex. The certificate authority is
shared with opencodex's Claude integrations; remove its trust only if you use neither.

## Troubleshooting

- **Account, usage or settings pages do not load:** the certificate is not trusted. Run
  step 2 again; `ocx chatgpt status` shows the trust state.
- **The send button is still grey:** check `ocx chatgpt status`. The app may be running
  without the route (run `ocx chatgpt launch`), or the lock may have a reason other than usage
  quota, which is listed under "send blocks kept".
- **The app cannot load anything after opencodex stops:** in the default mode a routed app
  depends on the listener. Start opencodex again or run `ocx chatgpt restore`, or turn on
  PAC fallback so the app falls back on its own.
