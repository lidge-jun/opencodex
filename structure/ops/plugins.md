# Local Plugins

Local plugins let an operator put code in front of provider sends without editing the core.
They are local extensions of one install, not a distribution channel: nothing fetches, updates
or signs them.

## Loading

- `ocx start` calls `loadAndReportOcxPlugins()` from `src/plugins/loader.ts` after the config is
  loaded and before `startServer`, so every hook is registered before the listener binds.
  `startServer` itself stays synchronous; plugin loading is awaited in the CLI, never inside it.
- The loader imports `*.ts`, `*.js` and `*.mjs` from `$OPENCODEX_HOME/plugins/`, sorted by name.
  Names starting with `.` or `_` and `*.d.ts` are ignored. A missing directory loads nothing.
- `OCX_PLUGINS=0` disables loading for that process.
- A plugin runs with the operator's credentials, so the loader refuses a plugin file or plugin
  directory that is a symbolic link (checked with `lstat`), is not a regular file/directory, is
  owned by another user, or is writable by group or others. This is the same trust boundary as
  `config.json`. Every ancestor of the resolved plugin directory up to `/` must be owned by the user
  or root and not group/other-writable unless sticky (`pluginAncestorsTrustError`), so no other user
  can swap a checked path before it is imported; files are imported through the resolved directory.
  Owner and mode checks are POSIX-only; on Windows only the file type is checked.
- A missing plugin directory means no plugins. Any other read failure (`EACCES`, `ENOTDIR`) is
  reported as a skipped `plugins directory` entry.
- A plugin module default-exports `{ name?, setup(context) }`. An asynchronous `setup` has five
  seconds; plugins share the proxy thread, so a setup that blocks synchronously cannot be
  interrupted. A plugin that throws, times out or has the wrong shape is reported and skipped:
  its context is closed, every hook it registered is removed, and a setup that resumes after the
  deadline cannot register again. A timed-out setup keeps running; resources it already opened
  are not closed. The other plugins and the proxy start normally.
- Plugins cannot import ocx modules: in a compiled binary they live inside `$bunfs`. Everything a
  plugin may use arrives through `OcxPluginContext` (`name`, `configDir`, `pluginDir`, `log`,
  `registerUpstreamRewriter`, `onShutdown`). `onShutdown` registers through
  `src/lib/optional-shutdown-hooks.ts` under a per-file, per-registration key, so plugins sharing a
  display name, and several teardowns from one plugin, all run.

## Upstream rewrite slot

`src/plugins/upstream-hooks.ts` is the only core-owned seam plugins attach to. It imports nothing,
so the request path depends on it without depending on the loader.

- It runs synchronously after the transport was chosen: HTTP in `sendWithConnectionPolicy`
  (`src/server/responses/fetch-helpers.ts`), including `Request` inputs, and the Codex WebSocket in
  `codexWsUpstreamFetch` (`src/server/responses/ws-upstream.ts`) once per exchange, before the pool
  lookup. `planCodexWsDial` applies the rewrite and settles the proxy; the dialled destination, rewritten
  headers and proxy are part of the reuse identity (`codexWsReuseIdentity` in
  `src/server/responses/codex-ws-pool.ts`), so a socket is never reused for another destination or
  with stale plugin headers. The per-turn headers in `CODEX_WS_FRAME_HEADERS`
  (`src/server/responses/codex-ws-request.ts`) ride in each frame's `client_metadata`, prepared
  before the rewrite and authoritative, so `planCodexWsDial` restores their original values and
  they stay outside the reuse identity. Rewriting any earlier would
  hide the ChatGPT origin from the WebSocket selection and push Codex turns onto HTTP. The target
  carries the URL, mutable headers and the transport (`http` or `websocket`).
- `sendWithConnectionPolicy` can run twice for one send (an override handing back to the supplied
  executor). The outer pass rewrites and marks the init; the inner pass does not rewrite again.
- A rewrite onto loopback dials directly on both transports: HTTP sends carry `proxy: false` and
  mark egress as decided; `rewriteWebSocketDial` drops the proxy the caller chose for the original
  destination. Other rewrites resolve their route against the rewritten URL on both transports (a
  WebSocket route that needs the SSE fallback falls back, as it would for the canonical URL). The pre-dispatch
  egress refusal in `providerFetch` still validates the provider's configured route against the
  original URL, so a misconfigured provider fails the same way with or without a plugin.
- With no rewriter registered, the send is returned untouched and nothing is allocated.
- A rewriter that throws has its own edits to that send undone and is disabled for the rest of the
  process. Rollback is per rewriter: edits from rewriters that ran before it are kept, and the send
  continues with them. `onShutdown` keys are unique per registration (`plugin:<file>#<n>`), so a
  plugin may register several teardowns.
- Rewrites happen after the request is built, routed and paced, so they do not change routing,
  account selection, retry budgets or logging identity. A rewriter that moves a send
  to another host owns that host's behaviour; the core does not re-validate it.
