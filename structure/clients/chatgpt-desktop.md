# ChatGPT desktop send-unblock

The opt-in macOS integration that keeps the ChatGPT desktop composer usable while the signed-in
subscription quota is exhausted and the turn is routed to another provider. It lives in
`src/chatgpt/desktop-unblock/`. User workflow: `docs-site/src/content/docs/guides/chatgpt-desktop.md`.

## Switch and scope

- `chatgptDesktop.unblockSend` is off by default; `chatgptDesktop.pacFallback` only takes effect
  together with it, and `runtimeRole: "client"` disables both. The block is validated at the write
  boundary (`validateConfigCandidate` rejects a malformed value); a hand-edited file degrades to off
  on load.
- Nothing here logs, stores or forwards a credential. Requests are relayed to the real
  `https://chatgpt.com` with the caller's own headers.

## Listeners

The listeners bind `127.0.0.1` and share one relay (`relayWithSendUnblock`) and one set of rewrites:

| Listener | Port | Purpose |
|---|---|---|
| TLS origin | `chatgptDesktop.port`, else public port + 200 | Receives the Chromium app's `chatgpt.com` traffic; certificate from the shared local intercept CA. |
| CONNECT entry | origin + 1 | PAC mode only. Accepts `CONNECT chatgpt.com:443` and nothing else, then splices onto the origin listener. |

The two ports wrap inside the TCP range without colliding. A bind failure degrades to a warning;
the proxy's other duties never depend on these listeners.

## Rewrites

Only the conversation endpoints and `/backend-api/wham/usage[/stream]` are rewritten (`rewriteSurfaceFor`);
every other response passes through byte-identical.

- Send blocks whose reason is usage quota (or absent) are removed from `blocked_features` and
  `limits_progress`; any other reason is kept and listed by `ocx chatgpt status`.
- On the usage snapshot `rate_limit.allowed` becomes true, `rate_limit.limit_reached` false, and a
  plain-quota `rate_limit_reached_type` is dropped. Workspace and credit variants are kept, and while
  one of them or a reached `spend_control` stands in the payload the flags stay as sent.
- Displayed usage (percentages, reset times, banners) is never changed.
- A JSON body over `MAX_REWRITE_BODY_BYTES` streams through unchanged instead of being buffered.

## Two places the gate is read

The composer's send gate can come from two different clients, and each needs its own switch:

- **The Chromium app** is launched with `--host-resolver-rules` (default mode) or an inline
  `--proxy-pac-url=data:` switch (PAC mode). A `file://` PAC is ignored by the app and an `http://`
  one would need opencodex alive to be fetched, so the script travels inline. When opencodex stops,
  the refused CONNECT makes Chromium fall through to the captured system chain with no restart. The
  launch watcher rebuilds the switch from the PAC file written at each start. Because the switch is
  one argv entry, `chooseChatgptUnblockPac` embeds a system PAC only while the encoded switch stays
  within `CHATGPT_UNBLOCK_PAC_SWITCH_MAX_BYTES` (512 KiB, half of macOS `ARG_MAX`); a larger one
  falls back to the scutil chain then DIRECT (`system-pac-too-large`, warned at start), since an
  oversized switch would make `open` fail after the watcher has already quit the app.
- **The bundled `codex app-server`** fetches the account rate limits with its own HTTP client, which
  no Chromium switch reaches, and reports them to the app over stdio JSON-RPC. The app picks the
  server binary from `CODEX_CLI_PATH`, so with `chatgptDesktop.appServerShim` the launch passes
  `open --env CODEX_CLI_PATH=<config dir>/chatgpt-codex-shim.sh`. That script `exec`s the real
  binary, so the server stays the process the app started (same pid, parent and code-signing
  identity; the app rejects any other peer on its app-tools pipe), and redirects only its stdout into
  `app-server-shim.ts`, a line filter: a line that mentions no rate-limit field is written back as
  the exact bytes it arrived in, and `rewriteAppServerLine` opens a plain-quota
  `rateLimitReachedType` and `ordinaryUsageAllowed` (also when a quota window reads 100%), keeping
  workspace or credit reasons and spend controls. The exported protocol schema shows these two
  messages, `account/rateLimits/read` and `account/rateLimits/updated`, as the ones that carry it.
  Stdin, stderr and signals go straight between the app and the server. The shim sets no environment
  variable, address or config key, so the server's children and other Codex clients are unaffected,
  and it never depends on opencodex running. Fail-open covers startup only: the launcher first runs
  the filter on empty input and `exec`s the binary with stdout untouched when that fails, so a
  filter that is missing or does not load never receives the server's stdout. Once the probe has
  passed there is no fallback; a filter that dies later takes the server's stdout with it.

The watcher decides whether an app is already launched correctly from its command line plus its
environment (`ps eww`), so an app started without the shim is corrected once. It finds the app with
`pgrep -a -x ChatGPT`: without `-a`, pgrep skips its own ancestors, and `ocx chatgpt` run from a
terminal inside the app has the app as one. `install-watcher` runs `bash -n` on the generated script
and refuses to load one that does not parse, and `restore` hands back an app carrying either switch.
`ocx chatgpt launch|restore|status|install-watcher`
(`src/cli/chatgpt-command.ts`) follow the configured modes.
