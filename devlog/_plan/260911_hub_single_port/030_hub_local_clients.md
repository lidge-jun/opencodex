# 030 — PR3: the hub's own local clients, two destination contracts

Unit: `devlog/_plan/260911_hub_single_port`. Stack position 3 of 4. Branch
`codex/260911-l4-hub-local-clients`, based on `codex/260911-l4-hub-loopback-companion`
(= `dev` + PR1 launchd repair + PR2 loopback companion). That base gained a review fix
(`0aca6afe4`, hub-gate conjunction + every all-zero hostname spelling) while this unit was being
written, so the branch was rebased onto it; there were no conflicts and every count below is from
the rebased tree. Issue:
lidge-jun/opencodex#4236 — the local-client follow-up table (eight hardcoded
`127.0.0.1:<public port>` sites) and the reviewer comment that they are **two** contracts.

PR2 closed the "Codex works but nothing else does" symptom for the *companion* form by moving the
socket instead of the call sites, and recorded the rest as open work: on a **ported** listener
(`{enabled:true, port:10104}`) the hardcoded callers still dialed the public port, and
`/v1/messages` plus `/api/claude-code` were not served on the listener at all. This unit closes
both halves — separately, because they are not the same surface.

## The two contracts

1. **Inference** — `localInferenceDestination(config, publicPort)` → `{ origin, port,
   requiresAdmissionToken }`. `http://127.0.0.1:<effective loopback port>` with no credential when
   `unauthenticatedLoopbackListener` is enabled; `http://127.0.0.1:<public port>` with no
   credential on a loopback bind; otherwise `http://<probeHostname(hostname)>:<public port>` AND a
   data-plane credential is required (a wildcard bind lands here too — it answers on 127.0.0.1,
   but the public listener still demands admission).
2. **Management** — `localManagementOrigin(config, publicPort)`: `http://127.0.0.1:<hub
   .managementIngress.port>` on a hub with the ingress enabled, otherwise
   `http://<probeHostname(hostname)>:<public port>`. The caller still sends the admin token;
   management authentication has no loopback bypass (`structure/05`), and the unauthenticated
   listener serves no `/api/*` — by design, not by omission.

The two share the same fallback shape on purpose. See "Review round" below: the first revision of
this unit gave inference no bind-address fallback at all, which left the exact topology the issue
is about still broken.

Both live in `src/lib/local-destinations.ts`, one small module whose header states the split, next
to the existing `local-management-*` helpers. It reuses PR2's `effectiveLoopbackListenerPort`,
`isWildcardHostname`, `shouldInjectApiAuthHeader` and `probeHostname`; no call site repeats
`?? port`, and none of them re-derives "does this bind need a key?".

## What shipped

### 1. Two inference wires on the unauthenticated loopback listener

`loopbackRouteAllowed` (`src/server/index.ts`) now admits `POST /v1/messages` (Anthropic wire:
`ocx claude`, Claude Desktop, the `system-env` injection) and `POST /v1/chat/completions` (OpenAI
chat wire: Cursor Private Inference, the routed vision helper, aside/opencode). Both handlers
already resolve admission from the RECEIVING listener's `RequestPolicyView` — the same resolver
and the same loopback short-circuit `/v1/responses` uses — so this adds a wire, not a trust level.
The allowlist comment says why, in the shape the existing entries use.

`POST /v1/messages/count_tokens` joined them in the review round (below). `/api/*`, `/healthz`,
`/readyz` and the GUI still 404 there.

One consistency fix rode along: the chat-completions branch finished its CORS with `config`
instead of the request's `policy`. On the public listener those are the same object, so this is a
no-op there; on the loopback listener it is the difference between CORS headers that match the
admission decision and headers derived from a bind address that did not receive the request.

### 2. Eight call sites, one resolver each way

| Site | Before | After |
| --- | --- | --- |
| `buildClaudeEnv` (`src/cli/claude.ts`) | `http://127.0.0.1:${publicPort}` | `localInferenceDestination` + `ANTHROPIC_AUTH_TOKEN` |
| `fetchClaudeCodeState` | `http://127.0.0.1:${publicPort}/api/claude-code` | `localManagementOrigin` + admin token |
| `writeDesktop3pConfig` → `generateDesktop3pConfig` | public port | `localInferenceDestination` + gateway api key |
| `refreshGatewayModelCacheFromProxy` | public port | `localInferenceDestination` + `x-opencodex-api-key` |
| `injectSystemEnv` / `writeShellEnvFile` | public port | `localInferenceDestination` + `ANTHROPIC_AUTH_TOKEN`, or a skip with a reason |
| Cursor gateway card | `http://127.0.0.1:${port}/v1` | `localInferenceDestination` + `apiKeyMode` |
| `resolveApiAccessBaseUrl` (final loopback fallback only) | `http://127.0.0.1:${port}/v1` | `localInferenceDestination` |
| `routedDescribeBaseUrl` | public port | `localInferenceDestination` + `x-opencodex-api-key` |

Three consequences worth naming:

- **`targetsLocalClaudeProxy` takes a SET of ports.** The public port and the listener's port are
  both ours. Treating the one this launch did not pick as a foreign proxy would strip our own
  admission token out of the environment and silently downgrade the launch; the stale-replacement
  branch and `buildNativeClaudeEnv`'s shedding branch both use the set.
- **The gateway-model cache had to move with `buildClaudeEnv`.** Claude Code honors that file only
  while its `baseUrl` equals `ANTHROPIC_BASE_URL`; moving one without the other would have left
  the picker on a stale list.
- **`system-env` tracking records three facts.** `port` is the owning proxy's identity, new
  optional `bindHost` is where its `/healthz` answers, and new optional `clientBaseUrl` is what was
  injected. Ownership on revert is proven against `clientBaseUrl ?? http://127.0.0.1:<port>`;
  liveness is probed at `bindHost`/`port`, because the loopback listener serves no `/healthz` (so
  probing the injected port would declare a live proxy stale) and 127.0.0.1 is not where a
  tailnet-bound hub listens (so probing it failed every time). Both fields are omitted when they
  carry nothing beyond `port`, so a plain loopback install writes a byte-identical record.
  `bindHost` is interpolated into a probe URL, so its shape is validated on read.

`resolveApiAccessBaseUrl` was touched ONLY in its last-resort loopback branch. Every branch above
it describes the address the *client* reached, and a remote caller must never be handed a port
that exists only on the hub's own 127.0.0.1.

### 3. Vision plan narrowing

`planVisionSidecar` hands `describeImageRouted` a narrowed config (`port`, `apiKeys`). The
listener field had to join it, or the resolver would have had nothing to resolve and the
self-fetch would have silently gone back to the closed port. A test pins the narrowing itself.

## Decisions

- **The reviewer's constraint is the design, not a caveat.** One base URL substituted everywhere
  would have meant either `/api/*` on the unauthenticated listener or an admin token in exported
  client configuration. Neither happens: the management resolver never returns the listener's
  port, and no exported configuration gained a credential.
- **`count_tokens` was not admitted in the first revision, and is now.** See "Review round": the
  argument for withholding it was scope, and scope is not a confinement argument when the same
  caller may POST the whole conversation to `/v1/messages` on the same socket.
- **Desktop/Cursor/system-env resolve where the config is, not in the generator.**
  `generateDesktop3pConfig` stays a pure generator taking "the local port to dial";
  `writeDesktop3pConfig` resolves from the config it already re-reads under the mutation lock, so
  every caller gets the same answer and no caller has to be taught about listeners.
- **Cursor's `apiKeyMode` now describes the destination it resolved.** It used to describe the
  public bind's admission rule, which was harmless only while the card always showed a loopback
  URL. Once the card can show the bind address, "here is the URL" and "you need no key for it"
  would be a contradiction, so the flag reads `gateway.requiresAdmissionToken` as well.
- **A restart is required for the ported form.** Verified against the live hub: the running
  pre-PR3 proxy answers `404` for `POST /v1/messages` on `127.0.0.1:10104` while
  `GET /v1/models` is `200`. After this PR the same request is served, so operators on the ported
  form must restart (macOS: `launchctl kickstart -k gui/$uid/com.opencodex.proxy`) before
  `ocx claude` can use the listener. Noted for the PR4 docs unit.

## Review round (second revision, same branch — new commits, no rewrite)

Six findings, all on the shape of the resolution rather than on the split itself.

1. **`localInferenceOrigin` had no bind-address fallback** (should-fix). With the listener OFF and
   `hostname` a tailnet address, all eight sites still got `http://127.0.0.1:<public port>` — a
   dead socket — and `tests/lib/local-destinations.test.ts` pinned that as intended. This is the
   topology #4236 is *about*, so the unit closed the ported form and left the reported one open.
   The resolver now mirrors `localManagementOrigin`'s shape and returns
   `{ origin, port, requiresAdmissionToken }`; `requiresAdmissionToken` is
   `shouldInjectApiAuthHeader`, the predicate that already encoded exactly this question, so the
   two cannot drift. Every call site then either attaches the data-plane credential — the
   `OPENCODEX_API_AUTH_TOKEN` / hardened service-token-file / `apiKeys` ladder, shared as
   `localAdmissionToken` with `refreshGatewayModelCacheFromProxy` and
   `routedDescribeAdmissionToken`, and **never the admin token** — or degrades with a log line
   naming the destination and the two fixes. `injectSystemEnv` degrades hardest: it returns
   `{ injected: false, reason }` rather than write a machine-wide base URL that 401s every plain
   `claude`, because a subscription launch cannot carry a host token at all (#253).
   `targetsLocalClaudeProxy` gained the destination origin as a second way to be ours, and the
   port set became `localLoopbackInferencePorts` — the ports that actually answer on 127.0.0.1,
   which is EMPTY on a tailnet bind with no listener, so a leftover `http://127.0.0.1:10100` is
   correctly rewritten instead of preserved. `buildNativeClaudeEnv` keeps a wider set: shedding
   asks "could we have written this?", and leaving such a URL behind with its token stripped is
   worse than shedding one port too many.
2. **`cleanStaleSystemEnv` probed an address that does not exist** (should-fix). It dialed
   `127.0.0.1:<public port>`, so on a tailnet-bound hub every liveness probe failed, the record
   was reverted on every start, and the "another instance owns env" guard could never fire — while
   the comment and test asserted the opposite. The tracking record now carries `bindHost`, the
   probe uses it, and the record's `clientPort` was replaced by the full `clientBaseUrl` (the field
   shipped in this PR only, so nothing released reads it).
3. **`probeHostname` knew three wildcard spellings** while `isWildcardHostname` (PR2) knew every
   all-zero form, so `0.0.0.0.`, `::0` and `*` were composed into literal URLs that resolve to
   nothing. `probeHostname` and `api-access.ts`'s `isWildcardBindHost` both call the shared
   predicate now; the (e) tests enumerate nine spellings.
4. **`Number(configuredPort())` could be `0`** in `routedDescribeBaseUrl` when `_corsOrigin` has no
   explicit port, composing `http://127.0.0.1:0`. Guarded with `|| 10_100`.
5. **`POST /v1/messages/count_tokens` is admitted on the loopback listener.** It spends no provider
   quota and reaches no stored credential, and withholding it bought no confinement — the same
   caller may POST the entire conversation to `/v1/messages` on that socket — while costing Claude
   Code its server-side count. The pinned 404 test became a pinned reachability test and the
   allowlist comment carries the argument. `/api/*`, `/healthz`, `/readyz` and the GUI stay 404.

   Widening the allowlist also turned a weaker assertion in
   `tests/server/reserve-ingress.test.ts` into a real one. Its two translated-wire cases asserted a
   local 404 and said outright that it "does NOT prove admission propagation inside the translated
   handler" — the 404 came from the allowlist, not from the handler. With the wires served, those
   requests reach the handler and give the same answer the Responses transport already gives on
   that listener: loopback admission makes Reserve eligible, so the turn is refused 429 behind a
   WHAM probe with nothing reaching the upstream, while the public listener's `dedicated` admission
   is not eligible and forwards the caller's own credential. The describe block's invariant —
   eligibility is decided by the RECEIVING listener, not the dial address — is now proven on four
   transports instead of two. One stale comment in the same file ("chat is intentionally not served
   by the secondary listener") was corrected.
6. **Docs**: `structure/01_runtime.md`'s socket paragraph was split into four; `structure/09` now
   states that `fetchClaudeCodeState` sends the admin token to the management ingress or, without
   one, to the bind address — host-local, never exported — and records the inference resolver's
   credential contract.

One hardening rode along with (1). `localAdmissionToken` shape-checks the token it reads from the
service token *file* (`/^[A-Za-z0-9._~+/=-]{8,4096}$/`) before sending it as a credential. A path
can be pointed at or replaced by something that is not a credential at all, and putting that in a
request header leaks file contents. The environment variable and configured `apiKeys` pass through
verbatim, so no existing key can be broken by the check.

`localInferencePort` was removed rather than kept as a wrapper: a bare port cannot express a
bind-address destination, so an exported convenience that returns one is a trap.

## Verification (exact commands, this branch)

First revision (counts superseded by the review round below, kept as the record):

```
bun run typecheck                                                   # clean
bun run privacy:scan                                                # Privacy scan passed
bun test tests/server/loopback-listener-admission.test.ts            # 31 pass
bun test tests/server/loopback-listener-integration.test.ts          # 35 pass
bun test tests/lib/local-destinations.test.ts                        # 8 pass
bun test tests/server/loopback-companion-client-targets.test.ts \
  tests/claude-integration/claude-cli.test.ts \
  tests/claude-integration/claude-gateway-cache.test.ts \
  tests/clients/desktop-3p.test.ts                                   # 88 pass
bun test tests/server/system-env.test.ts \
  tests/server/api-access-endpoints.test.ts \
  tests/providers/cursor/cursor-integration-status.test.ts \
  tests/vision/vision-routed.test.ts \
  tests/claude-integration/claude-system-env-auto.test.ts            # 61 pass
bun test tests/claude-integration/claude-auth-detect.test.ts \
  tests/claude-integration/claude-auth-mode.test.ts \
  tests/claude-integration/claude-management-api.test.ts \
  tests/claude-integration/claude-shell-hook.test.ts \
  tests/cli/cli-management-auth.test.ts                              # 110 pass (with the one above)
bun test tests/clients/desktop-3p-guard.test.ts \
  tests/clients/desktop-remote-store.test.ts \
  tests/clients/sync-client-integrations.test.ts \
  tests/codex-integration/model-visibility-management-api.test.ts \
  tests/codex-integration/native-claude-desktop-toggle.test.ts       # 92 pass
bun test tests/providers/cursor/cursor-effort-rows.test.ts \
  tests/providers/xai/grok-lifecycle.test.ts \
  tests/server/api-keys-routes.test.ts                               # 85 pass
bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts # 17 pass
bun test tests/ci-workflows/docs-remote-hub-claims.test.ts           # 7 pass
```

Review round, at the pushed head:

```
bun run typecheck                                                    # clean
bun run privacy:scan                                                 # Privacy scan passed
bun test tests/lib/local-destinations.test.ts \
  tests/server/loopback-listener-admission.test.ts \
  tests/server/loopback-listener-integration.test.ts \
  tests/server/system-env.test.ts \
  tests/claude-integration/claude-cli.test.ts \
  tests/clients/desktop-3p.test.ts \
  tests/server/api-access-endpoints.test.ts \
  tests/providers/cursor/cursor-integration-status.test.ts \
  tests/vision/vision-routed.test.ts \
  tests/server/loopback-companion-client-targets.test.ts             # 241 pass
bun test tests/server/reserve-ingress.test.ts                        # 32 pass
bun test tests/cli/cli-export-command.test.ts \
  tests/cli/hub-gated-local-clients.test.ts \
  tests/clients/integrations-writer.test.ts \
  tests/codex-integration/codex-desired-state.test.ts \
  tests/codex-integration/reserve-auth-context.test.ts \
  tests/codex-integration/reserve-catalog.test.ts \
  tests/codex-integration/reserve-dispatch.test.ts \
  tests/codex-integration/reserve-helper-boundary.test.ts \
  tests/providers/xai/grok-sync.test.ts \
  tests/server/management-client-config-route.test.ts \
  tests/server/reserve-claude-policy.test.ts                         # 245 pass
bun test tests/claude-integration/claude-gateway-cache.test.ts \
  tests/claude-integration/claude-system-env-auto.test.ts \
  tests/claude-integration/claude-shell-hook.test.ts \
  tests/claude-integration/claude-management-api.test.ts \
  tests/clients/desktop-3p-guard.test.ts \
  tests/clients/desktop-remote-store.test.ts \
  tests/clients/sync-client-integrations.test.ts \
  tests/codex-integration/native-claude-desktop-toggle.test.ts       # 122 pass
bun test tests/server/proxy-liveness.test.ts \
  tests/codex-integration/codex-inject.test.ts \
  tests/codex-integration/codex-inject-integration.test.ts \
  tests/test-layout.test.ts tests/test-layout-tooling.test.ts        # 215 pass
bun test tests/cli/cli-management-auth.test.ts \
  tests/claude-integration/claude-auth-detect.test.ts \
  tests/claude-integration/claude-auth-mode.test.ts \
  tests/server/api-keys-routes.test.ts \
  tests/providers/cursor/cursor-effort-rows.test.ts \
  tests/ci-workflows/docs-remote-hub-claims.test.ts                  # 125 pass
```

`tests/lib/local-destinations.test.ts` now enumerates the review's six configurations — standalone
loopback, companion hub, ported hub, listener-off + non-loopback bind, wildcard bind, client role —
as one table driving both the destination and the loopback-port-set assertions, so a new branch
that forgets `requiresAdmissionToken` fails there rather than in production.

New test file registered in `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`: `tests/lib/local-destinations.test.ts` → `lib`.

Updated PR2's witness case in `tests/server/loopback-companion-client-targets.test.ts`: the
"ported form still splits the two" assertion was the record of the gap this unit closes, and now
asserts the agreement instead.

No repository-wide suite (operator instruction); hosted CI at exact head is the proof.

### Live acceptance (read-only, this machine)

`~/.opencodex/config.json`: `runtimeRole: hub`, `hostname: 127.0.0.1`, `port: 10100`,
`unauthenticatedLoopbackListener: {enabled:true, port:10104}`,
`hub.managementIngress: {enabled:true, port:10102}`. A read-only script (scratchpad, not
committed) loaded that config, probed liveness, and resolved both destinations — no config write,
no restart, no `repair`/`ensure`/`sync`:

```
live proxy port: 10100 | source: runtime
resolved management origin: http://127.0.0.1:10102
resolved inference origin:  http://127.0.0.1:10104
fetchClaudeCodeState enabled: true | windows: 264
ANTHROPIC_BASE_URL origin: http://127.0.0.1:10104
```

`enabled: true` is the acceptance case: before this unit that call dialed
`127.0.0.1:10100/api/claude-code` — which happens to answer on THIS host because the bind is
loopback, but returns nothing on a tailnet-bound hub, and `ocx claude` then launches native.

## Left for the rest of the stack

- PR4 (token UX + `ocx hub invite` + `ocx status` hub block) and the docs/skill unit own the
  operator-facing copy. The docs note that matters: restart after changing
  `unauthenticatedLoopbackListener`, and the ko copies of
  `reference/configuration/server.md` still describe only the ported form (PR2's note).
- Both former follow-ups are closed in the review round above: `count_tokens` is admitted, and
  Cursor's `apiKeyMode` now keys on the resolved destination.
- Open, and deliberately not in this unit: `resolveApiAccessBaseUrl` describes the GUI's API-access
  panel, and on a credential-demanding destination the panel's copy is the PR4/docs decision, not a
  resolver change.
