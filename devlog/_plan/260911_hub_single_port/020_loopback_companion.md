# 020 — PR2: same-port loopback companion, honest hub-gate messages

Unit: `devlog/_plan/260911_hub_single_port`. Stack position 2 of 4 (PR1 = launchd repair,
PR3 = hub token UX, PR4 = docs/skill). Branch `codex/260911-l4-hub-loopback-companion`,
based on `dev` = `babb76449` (`Merge pull request #4240 … codex/260911-l4-client-catalog`); it
will be rebased onto PR1's branch. Issue: lidge-jun/opencodex#4236 (follow-ups 1 and 2,
defect 4).

The assigned worktree was created at `origin/main` (`06ec55363`), 1071 commits behind `dev`, so
the whole branch was rebased onto `dev` before verification. Conflicts were only in
`src/cli/index.ts` (three "startup left Codex native" call sites that `dev` had grown Raycast
comments around) and `src/codex/inject.ts` (the legacy-uncoordinated skip now lives inside
`applyLegacy`, under the config mutation lock); both were resolved by keeping `dev`'s structure
and putting the honest message inside it. Every count below is from the rebased tree.

## What shipped

### 1. `ocx gui` on a hub opens the local management ingress (first commit)

`ocx gui` derived its URL from the proxy bind, so a hub with `hostname: "<tailnet IP>"` opened a
browser at the tailnet origin while the hub's own loopback management ingress sat unused.
`selectDefaultGuiUrl` now prefers `http://localhost:<ingress port>` when `runtimeRole: "hub"` has
`hub.managementIngress.enabled`; every other topology keeps the previous derivation byte for byte.

### 2. The companion form of `unauthenticatedLoopbackListener`

`port` is now optional. `{ "enabled": true }` means "bind `127.0.0.1:<proxy port>`" — one port for
the whole hub: remote clients dial `hostname:port` with a credential, local processes dial
`127.0.0.1:port` without one, and every integration that hardcodes `http://127.0.0.1:<proxy port>`
(`ocx claude`, Claude Desktop, Cursor, `system-env`, the vision helper — the eight sites in the
issue's table) keeps working with **no edit to those call sites**. That was the whole point: the
PR changes where the socket is, not what the clients write.

Legal only when `hostname` is a specific non-loopback, non-wildcard address. On
`127.0.0.1`/`localhost`/`::1`/`0.0.0.0`/`::` the public listener already owns that loopback
address, so the pair is refused:

- at the write boundary (`loopbackListenerPortError` → `loopbackCompanionBindError`), reading both
  `hostname` and the listener from the same candidate, so `ocx config set hostname 127.0.0.1` on a
  companion host is refused by the same check rather than breaking the next start;
- at startup in `startServer`, before any bind, with the identical sentence — a hand edit that
  skipped the boundary must not surface as EADDRINUSE from a rolled-back transaction.

The message names the collision (`127.0.0.1:<proxy port>`) and both fixes: set a distinct
`port`, or drop the listener because a loopback bind already admits local callers.

### 3. One resolver, every reader

`effectiveLoopbackListenerPort(config, publicPort)` in `src/codex/loopback-target.ts`, next to
`isLoopbackHostname`, plus `isWildcardHostname` / `loopbackCompanionAllowed`. Used by
`standaloneCodexRoutingTarget` (which `opencodeProxyBaseUrl`, `syncGrokConfig` and the integration
state exporter already go through), the server's listener transaction, and the `ocx status` drift
check. Deliberately NOT used in `chooseListenPort`: only an explicitly ported listener reserves a
port, because the companion form shares the public one and reserving it would refuse every start.

Startup log now distinguishes the two forms — companion:
`🔁 Loopback companion active on http://127.0.0.1:<port> — same port as the public listener; local
processes need no credential`; ported: today's four-line unauthenticated-surface warning, verbatim.

### 4. Drift warnings accept the whole locally reachable set (defect 4)

`grokFenceEndpointDrift` takes an optional second reachable port. `ocx status` passes
`effectiveLoopbackListenerPort(config, listen.port)`, so a fence naming the listener's port — the
port `ocx sync` itself wrote — is no longer reported as drift against a closed port. A third port
still warns, still against the public listener.

### 5. Hub-gate honesty (follow-up 2)

`localClientSyncAllowed` refusing to rewrite a hub's own clients is the right decision; reporting
it as the user's toggle was not. New `"hub-gated"` reason and one sentence:

> This machine is a hub; it does not rewrite its own Codex/Grok/Claude configs unless
> unauthenticatedLoopbackListener is enabled.

Threaded through `CodexWriteLockSkipReason` → `codexInjectLockOutcome` → `CodexInjectResult` →
`CodexSyncResult`, and used by `ocx sync`, `ocx sync-cache`, the three `startup left Codex native`
lines, and `ocx restore back` — which previously committed the toggle ON and then told the operator
to "retry after the competing integration change finishes", a writer that does not exist.

`ocx ensure` no longer strips the managed Grok block on a hub-gated skip: only an explicit
`clientIntegrations.grok === false` authorizes the strip. A gated hub with Grok ON is told why
nothing was written and `~/.grok/config.toml` is left exactly as it is.

## Decisions

- **The route allowlist was NOT widened.** `loopbackRouteAllowed` still serves only the Codex
  data-plane set, so on a companion hub `http://127.0.0.1:<port>/v1/messages` and `/api/*` still
  return 404. A companion is a bind-address change, never an admission change (maintainer review
  on #4236: "Do not add `/api/*` to the unauthenticated listener"). A test pins this.
  **Consequence, recorded as open work:** `ocx claude` and `fetchClaudeCodeState` on a
  tailnet-bound hub reach a live socket but get 404 on the Anthropic wire and on
  `/api/claude-code`. Closing that needs the two destination contracts the reviewer described —
  authenticated local management discovery vs. per-wire inference — which is its own change, not
  this one.
- **`port` stays non-OS-assigned in both forms.** An ephemeral port would change across restarts
  while running app-servers held the previous `base_url` (#1102).
- **`startServer` stays synchronous** and the companion check is a plain throw before the first
  `Bun.serve`, so the listener transaction and its rollback are untouched.
- **The hub-gate reason rides the existing lock skip channel** rather than a parallel one: the
  skip is already linearized under the Codex write lock, and a second channel would let the
  reason and the write disagree.
- Docs: the English `reference/configuration/server.md` paragraph that said "the port is required"
  was false after this change, so it now documents both forms. The full docs/skill rewrite
  (en + ko, remote-hub guide) is PR4; the other locale copies still describe only the ported form.

## Verification (exact commands, this branch)

```
bun run typecheck                                                  # clean
bun run privacy:scan                                               # Privacy scan passed
bun test tests/server/loopback-listener-admission.test.ts \
  tests/server/loopback-companion-client-targets.test.ts \
  tests/server/server-loopback-host-gate.test.ts                   # 44 pass
bun test tests/server/loopback-listener-integration.test.ts        # 34 pass
bun test tests/cli/hub-gated-local-clients.test.ts \
  tests/cli/cli-dispatch.test.ts                                   # 50 pass
bun test tests/providers/xai/grok-status.test.ts tests/providers/xai/grok-sync.test.ts \
  tests/providers/xai/grok-lifecycle.test.ts \
  tests/codex-integration/codex-desired-state.test.ts \
  tests/codex-integration/codex-inject.test.ts \
  tests/codex-integration/codex-sync-api.test.ts \
  tests/cli/ensure-desired-integrations-race.test.ts               # 149 pass
bun test tests/config/config-user-edits.test.ts tests/config/config-load-degrade.test.ts \
  tests/cli/cli-json-contract.test.ts tests/cli/cli-restore-back.test.ts \
  tests/clients/integrations-writer.test.ts tests/clients/sync-client-integrations.test.ts \
  tests/server/startup-prompt.test.ts                              # 177 pass
bun test tests/cli/cli-transport-honesty.test.ts tests/cli/cli-status-json.test.ts \
  tests/cli/cli-config-command.test.ts tests/cli/cli-start-journal-order.test.ts \
  tests/cli/cli-capabilities.test.ts tests/cli/cli-help.test.ts     # 108 pass
bun test tests/codex-integration/codex-write-lock.test.ts \
  tests/codex-integration/codex-inject-write-lock.test.ts \
  tests/codex-integration/codex-composed-acceptance.test.ts \
  tests/codex-integration/codex-history-lock.test.ts \
  tests/lab/lab-activation.test.ts tests/lab/core-lab-boundary.test.ts \
  tests/test-layout.test.ts tests/test-layout-tooling.test.ts       # 98 pass
bun test tests/update/update-stop-first.test.ts                    # 23 pass
```

One pre-existing test needed a harness line: `tests/clients/sync-client-integrations.test.ts`
transpiles the real `handleEnsure` body and evaluates it with every free identifier injected, so
the new `startupLeftCodexNativeLine` had to be added to that injection map.

The GUI does not render this field (`grep -rni loopback gui/src` finds only unrelated copy), so
there is no GUI change and `lint:gui` was not required.

No repository-wide suite (operator instruction); hosted CI at exact head is the proof.

New test files registered in `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`:
`tests/server/loopback-companion-client-targets.test.ts`,
`tests/cli/hub-gated-local-clients.test.ts`.

The same-port integration case needs a non-loopback IPv4 interface to tell the two sockets apart;
on a host without one it warns and returns rather than passing silently (matching the existing
bind-scope case in that file).

## Left for the rest of the stack

- PR3: data-plane token auto-provisioning, `ocx hub invite`, the `ocx status` hub block (which
  should print the companion state this PR introduces).
- PR4: `guides/remote-hub.md` en + ko around the one-port recipe, the other locale copies of
  `reference/configuration/server.md`, `skills/ocx`.
- Follow-up (not in this stack as scoped): the Claude/management destination split described
  above, i.e. what `ocx claude` should dial on a companion hub.

## Review round (coordinator)

Two findings from the read-only review, both fixed in a follow-up commit:

- `localClientSkipReason` claimed `"hub-gated"` even when the operator's own toggle was OFF, which
  would have sent that operator to enable a listener that cannot make the sync happen. The reason is
  now the conjunction the Grok path already used: toggle ON **and** gate closed. It takes the client
  id (default `codex`) so a Grok OFF does not silence the Codex gate.
- `isWildcardHostname` missed the IPv6 unspecified aliases (`::0`, `[::0]`, `0::`,
  `0:0:0:0:0:0:0:0`), bare `0`, and padded IPv4 zeros. A `hostname: "::0"` companion would have
  passed both checks and then rolled back with EADDRINUSE — the exact misdiagnosis the check exists
  to prevent. Normalisation now strips brackets and matches any all-zero spelling.

Verification: `bun test tests/cli/hub-gated-local-clients.test.ts tests/server/loopback-listener-admission.test.ts tests/server/loopback-listener-integration.test.ts tests/cli/cli-dispatch.test.ts tests/clients/sync-client-integrations.test.ts` → 144 pass / 0 fail; `bun run typecheck` clean.
