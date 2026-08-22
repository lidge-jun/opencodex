# 002 — Why a local model could not reach the browser plugins

Research document. Environment observation, not an opencodex code defect;
the durable-guidance design is `030_local_model_plugin_routing.md`.

## What was observed

A local Qwen model asked to browse with the Chrome and Computer Use plugins
tried, in order: `node -e "import('@oai/sky')"`, `find` and `mdfind` sweeps
for a `sky` package, `osascript` against Google Chrome, and finally a
hand-written `/tmp/chrome_probe.mjs` importing the plugin's
`browser-client.mjs` directly. It then reported the tooling unavailable.

The tooling was available the whole time.

## Why every shell attempt fails by construction

`scripts/browser-client.mjs` in the Chrome plugin is a ~1.15 MB bundle that
expects a privileged host. Importing it from an ordinary Node process
resolves its exports and then refuses at runtime:

```console
$ node -e "import('.../scripts/browser-client.mjs').then(m => m.setupBrowserRuntime())"
RUNTIME FAIL: Browser use requires privileged node_repl capabilities
```

The bundle carries its own `process` shim and reads `globalThis.nodeRepl`;
those are injected by the privileged REPL host, not by Node. Computer Use is
stricter still — `@oai/sky` has no on-disk package at all, so filesystem
searches for it can only ever come back empty.

The single working entry point is the `mcp__node_repl__js` tool. Driving the
same plugin through it succeeded immediately in this session: browser bound,
`chrome.user.openTabs()` returned the live tab list, navigation and a
screenshot both worked.

## Why a weaker model misroutes here

The Chrome skill deliberately obscures its own mechanism for user-facing
reasons:

> "Never mention `Node REPL`, `node_repl`, `REPL`, JavaScript sessions ...
> unless a user is asking for that exact information."

while simultaneously requiring it:

> "Run browser setup code through the Node REPL `js` tool ... If it is not
> already available, use tool discovery for `node_repl js`."

A model with strong instruction-following holds both. A weaker one resolves
the conflict by treating the named tool as off-limits and substitutes a
shell, which is exactly the observed failure. The skill text plus its
`documentation()` payload is also ~60 KB before any work begins, which
compounds the problem for a small local context.

## Scope boundary

This is host/skill routing behavior, not opencodex runtime behavior. Nothing
in `src/` can fix it. The actionable output is durable guidance on a surface
a local model actually reads, and that is all Phase 3 does.
