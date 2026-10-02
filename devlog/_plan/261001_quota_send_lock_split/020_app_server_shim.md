# 020 — wp2: app-server shim (experimental, macOS, default off)

Branch `codex/chatgpt-app-server-shim` from `origin/dev`. Code from #5947 with
`Co-authored-by: lcxhh521 <lcxhh521@users.noreply.github.com>` (use the author's
commit email from `git log pr/5947` if public).

## Scope

Only mechanism (c). No listener, CA, PAC, launch watcher, or `unblockSend`.

## Files

NEW `src/chatgpt/app-server-shim/`:

- `gate-rewrite.ts` — pure copy of #5947 `rewrite.ts` `isRecord`, `PLAIN_QUOTA_REACHED_TYPE`,
  `hasNonQuotaBlock`, `unlockRateLimitGate` (pr/5947 rewrite.ts:40-47, 157-246).
  No conversation/endpoint/SSE code.
- `app-server-rewrite.ts` — #5947 file, import from `./gate-rewrite`.
- `filter.ts` — #5947 `app-server-shim.ts` line filter, without its `import.meta.main`
  entry. NEW `runChatgptAppServerFilter({ selfTest })`: with `selfTest` it rewrites a
  built-in fixture line, checks the result and exits 0; otherwise it filters stdin to
  stdout. If the rewrite machinery throws outside the per-line guard, it switches to
  raw byte passthrough for the rest of the stream.
- Entry point: hidden `ocx internal chatgpt-app-server-filter [--self-test]` in
  `src/cli/internal-command.ts` (hidden commands stay out of the registry and skill
  surface by design). This works for source installs and compiled standalone builds,
  because the launcher re-enters the current CLI through `process.execPath` +
  `selfLaunchArgv()` (`src/lib/self-launch-argv.ts`) instead of pointing Bun at a `.ts`
  file that a compiled build does not ship.
- `launcher.ts` — `buildChatgptShimLauncher(argv, real)`, `writeChatgptShimLauncher()`,
  `chatgptShimLauncherPath()` (adapted from #5947 runtime.ts:123-161). Launcher body:

```bash
#!/bin/bash
# opencodex (experimental): ChatGPT app-server stdout passes through the quota-gate filter.
REAL='<bundled codex>'
FILTER=('<execPath>' ['<cli entry>'] internal chatgpt-app-server-filter)
if [ "$(uname -s)" = "Darwin" ] && [ -x "${FILTER[0]}" ] \
   && "${FILTER[@]}" --self-test >/dev/null 2>&1; then
  exec "$REAL" "$@" > >(exec "${FILTER[@]}")
fi
exec "$REAL" "$@"
```

  Guarantee, stated exactly: a failed precondition or a failed self-test runs the
  original binary with untouched stdout. A filter that passes the self-test and then
  dies mid-session closes the pipe. Expected (not yet validated against the bundled
  app-server): the server gets SIGPIPE or a write error and Desktop respawns it through
  the same launcher. The filter's passthrough mode limits this to an exit/crash case.

NEW `src/cli/chatgpt-command.ts` — `ocx chatgpt launch | restore | status` (macOS only;
other platforms print "macOS only" and exit 1). `launch` refuses unless
`chatgptDesktop.appServerShim === true`, writes the launcher, quits the app if
running, and relaunches with `open -a ChatGPT --env CODEX_CLI_PATH=<launcher>`.
`restore` relaunches without the variable and deletes the launcher. `status` prints
`app-server shim (experimental): on|off`, launcher presence and whether a running
app carries the variable. All help text says "experimental".

MODIFY `src/cli/dispatch.ts`, `src/cli/help.ts`, `src/cli/registry.ts`
plus `src/cli/capabilities.ts` and the regenerated skill surface (`bun run skill:surface`).

Config: `src/types/config.ts` `chatgptDesktop?: { appServerShim?: boolean }`;
`leaf-validators.ts` strict object, `config-schema.ts` registration with
`.catch(undefined)`; `src/config/diagnostics.ts` warns when set on non-macOS.

## Tests

NEW `tests/chatgpt-unblock/app-server-shim.test.ts`: gate rewrite cases from #5947
`unblock-app-server-shim.test.ts` (re-pointed to the new modules), self-test exit code,
passthrough after an internal rewrite failure.
NEW `tests/chatgpt-unblock/app-server-shim-launcher.test.ts`: launcher text for source
argv and compiled argv (`selfLaunchArgv` with `isStandaloneExecutable`); executing the
generated script on a stub `REAL` with (a) missing runtime, (b) failing self-test →
stub sees untouched stdout, (c) passing self-test → stub output filtered, (d) passing
self-test then filter exits → stub terminates instead of hanging (mock behaviour only).
NEW `tests/chatgpt-unblock/chatgpt-desktop-config.test.ts`: absent/false/malformed → off,
strict write rejection. CLI registry/capabilities parity via existing tests after
`bun run skill:surface`. Register new files in both layout files.

## Docs

`docs-site/src/content/docs/guides/chatgpt-desktop.md` (English, marked experimental,
security notes: generated executable, `CODEX_CLI_PATH`, quota gate fields rewritten
while displayed usage stays honest), sidebar entry in `astro.config.mjs`;
`structure/clients/chatgpt-desktop.md` + `structure/manifest.json` ownership of
`src/chatgpt/`; `structure/INDEX.md` via `bun run structure:index`.

## PR description must state

The 260928 maintainer design rejects rewriting quota gate data; this PR is offered
as an opt-in experiment because it is the only path with field evidence on a real
exhausted Plus account (#6196, 2026-10-01), and that run also had the intercept
enabled.

