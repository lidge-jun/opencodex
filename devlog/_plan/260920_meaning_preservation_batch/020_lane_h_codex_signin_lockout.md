# Lane H — Codex sign-in lockout behind a stopped proxy (#5261)

Status: OPEN. Base is `origin/dev` at `b9483b3b51`. One branch, ordered commits, one pull
request to `dev`, matching the topology in [010_phase2.md](010_phase2.md).

This lane is not a consolidation bundle. It is incident response to a user report, and it
was scheduled ahead of the phase 2 lanes because the reported failure ends with the user
unable to sign in to Codex at all.

## What was reported

A Windows 11 user on 2.59.0 configured opencodex, repeatedly failed to add accounts to the
pool, then found Codex could no longer call models. After a restart Codex would not sign in,
showing only a retry. Three screenshots on the issue show the cause on their machine: the
root override in `~/.codex/config.toml` pointing at `http://127.0.0.1:10100/v1` with the
proxy process gone, and a `model_catalog_json` naming a catalog file that no longer existed.

## What the source says

Four independent reads of `dev` agreed on the following. No proxy was started and no config
was touched to establish any of it.

1. The default loopback injection does not add a provider. It sets the codex-rs root key
   `openai_base_url`, which redirects Codex's own built-in `openai` provider
   (`src/codex/inject.ts:102`), plus `experimental_realtime_ws_base_url` and
   `model_catalog_json`. It is written with an atomic replace into `$CODEX_HOME/config.toml`
   (`src/codex/inject.ts:591`), so it survives a reboot.
2. No auth, token or sign-in endpoint is separately redirected at the proxy. The redirect is
   the built-in provider's base URL, and Codex has no second endpoint to fall back to.
3. There is no liveness precondition on the write (`src/codex/inject.ts:190`) and no
   fail-open path back to the real upstream anywhere in the runtime.
4. Applying the integration does not install a service; that is a separate
   `ocx service install` (`src/cli/init.ts:226`, `src/cli/init.ts:255`). The Windows
   scheduled task carries a logon trigger and no boot trigger
   (`src/service/windows-taskxml.ts:225`). Injection present with nothing listening is
   therefore an ordinary post-reboot state, not a corruption.
5. The shim runs `ocx ensure` with output discarded and `|| true`, then launches the real
   Codex regardless (`src/codex/shim-templates.ts:134`), so a failed auto-start is silent.
   It is also CLI-only (`src/codex/autostart-health.ts`), so it never covered the reporter,
   who was in the Codex app.
6. Recovery already existed and already worked offline: `ocx restore` needs no proxy, no
   management API and no network (`src/cli/dispatch.ts:198`). It was simply not discoverable.
   `ocx status` on a dead proxy offered only ways to restart it (`src/cli/index.ts:1586`),
   the injected config named no command, and no troubleshooting page covered the state.

## The account-pool failures are a second cause

They began the session but are not the lockout. The pool is served by the management API, so
both `ocx account login openai` and the dashboard roster need a live proxy
(`src/cli/runtime-api.ts:68`). The browser flow additionally needs the fixed callback port
1455, which cannot move (`src/oauth/callback-server.ts:137`), and the Windows browser launch
swallows its own failure (`src/lib/open-url.ts:20`). The dashboard keeps the last good rows
after a failed refresh (`gui/src/hooks/useCodexAccountPool.ts:325`), which is why a new
account can be absent while older ones still show. Documented, not changed, in this lane.

## What this lane changes

The direction taken is the second of the two the incident allows. Excluding sign-in from the
proxy path is not expressible: `openai_base_url` is one key for one built-in provider, and
when the proxy is down no scoping helps. So the failure is made detectable and the recovery
discoverable.

1. Routing markers name their own undo: `# Auto-injected by opencodex (undo: ocx restore)`.
   Ownership is matched as a substring everywhere, so older markers keep working, and an
   in-place rewrite refreshes the line so existing installs gain it on the next start.
2. `ocx status` on a dead proxy over routing we own now says sign-in fails too, and names
   the command that does not need the proxy back.
3. A troubleshooting page for the state, including the manual edit and the warning against
   dropping the catalog pointer alone.
4. Regression tests that reconstruct the reported config and run recovery with nothing
   listening.

## What it does not close

- The shim still discards `ocx ensure` failures, and remains CLI-only, so the Codex app is
  still not covered by auto-start at all.
- Nothing revalidates `model_catalog_json` after injection. The inject-time chooser refuses a
  missing owned catalog (`src/codex/inject/config-toml.ts:597`), but a file removed later
  leaves a pointer that makes Codex fail to load its config.
- Windows autostart has no boot trigger, so the post-reboot gap is unchanged.

Each is a separate change with its own risk, and none of them is what locks the user out on
its own. The issue stays open for them.

## Verification

Static source review and exact-head hosted CI only. No local suite, typecheck, build, install,
service action or `ocx` invocation was used to establish any claim above, because the incident
itself is a configuration change that locked a user out.
