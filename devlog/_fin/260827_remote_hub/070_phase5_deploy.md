# 070 — Phase 5: deployment integration and remote-hub dogfood

Unit: `260827_remote_hub` · Phase: 5/6 · Work class: C4 (auth + deployment) · Status: implementation-ready

Dependencies: Phases 1–4 are complete. In particular, this phase assumes the Phase-1
`/readyz` protocol contract and `/v1/catalog`, the Phase-2 remote-session issuance
contract, the Phase-3 `ocx connect` transaction and per-client token file, and the
Phase-4 machine listener/two-plane GUI exist at the paths named by their phase docs.

This document is the diff-level implementation contract. Every command that executes
TypeScript or tests runs on `ssh lidge-ai`, never on the workstation. The live deployment
smoke is the separately scoped `ssh clisu-oracle` dogfood described in §8.

## 0. Locked outcome and boundaries

Phase 5 makes a hub operable on a headless Linux host, macOS launchd host, or Docker
container without widening the data or consent planes.

### IN

- An opt-in second hub listener bound exactly to `127.0.0.1`, serving only packaged GUI
  routes, SPA routes, `/opencodex-session`, and `/api/*`.
- Tailscale Serve as the recommended HTTPS frontend for that listener, with
  `remoteGui.allowedTailscaleUsers` still deciding who may mint a session.
- Existing `ocx service install` for launchd/systemd. The data token is persisted only
  through the existing owner-only `service-api-token` path and is never rendered into a
  plist or unit.
- A Docker recipe that runs non-root, persists `~/.opencodex`, reads a mounted secret via
  `OCX_API_TOKEN_FILE`, and probes both `/healthz` and `/readyz`.
- Headless OAuth using `oauthOpenBrowser:false` and the existing manual-code endpoint.
- A real `clisu-oracle` hub + MacBook client dogfood, including remote session issuance,
  per-machine usage attribution, and protocol compatibility evidence.
- English deployment documentation in the new remote-hub guide. Locale and reference-page
  synchronization is Phase 6 (§080), after the security contract is final.

### OUT

- No public Funnel preset, public-internet ingress, cloud firewall automation, generic
  reverse proxy, Kubernetes, registry image, image publish workflow, or hosted control plane.
- No root `Dockerfile` or `.dockerignore` in this phase. The repository currently has
  neither. Shipping one would create a maintained image/release surface requiring pinned
  base digests, scanning, SBOM, signing, and rollback policy. The guide instead includes a
  copyable multi-stage Dockerfile recipe and makes the operator own the resulting image.
- No service-manager rewrite. Windows remains supported by the existing service path but is
  not a Phase-5 deployment target; the requested targets are systemd and launchd.
- No key-rotation UX, pairing throttles, skew fuzzing, catalog adversarial matrix, or relay
  hardening; those are Phase 6.
- No traffic mirroring or usage-log mirroring. Connected clients render their own
  `apiKeyId` slice from the hub store; disconnected clients render the local store.
- No import, direct or transitive, from a new subsystem into `src/router.ts`,
  `src/server/lifecycle.ts`, or `src/server/responses/core.ts`.

## 1. Deployment trust boundaries

| Asset / boundary | Required control |
| --- | --- |
| Provider/OAuth credentials on hub | Never copied to a client, container layer, unit, plist, docs output, or dogfood artifact. |
| Data admission token | Delivered by `serviceApiTokenFilePath()` or `OCX_API_TOKEN_FILE`; never an argv value and never logged. |
| Management admin token | Remains hub-only. It may perform ordinary `/api/*` administration but must never mint or exchange into `gui-session`. |
| Tailscale identity headers | Trusted only when the request arrived on the new loopback management listener. Identical headers on the public listener are ignored. |
| Browser consent | Only the Phase-2 `gui-session` predicate authorizes consent routes. `allowedTailscaleUsers` is an issuance allowlist, not a new principal. |
| Docker volume | Holds provider credentials, OAuth state, usage, config, and service secrets; owner-writable only and never baked into an image. |
| Dogfood evidence | Records versions, protocol values, key ids/prefixes, counts, and HTTP status only; no tokens, emails, request bodies, account ids, or raw usage rows. |

Rollback is configuration-first: disable the management ingress or Tailscale Serve without
changing the main data listener; stop the branch service and repair the prior release against
the same `OPENCODEX_HOME`; remove a container while retaining its named volume.

## 2. Diff-level file-change map

All existing paths below were verified against the 2026-08-28 tree. `NEW` paths have an
existing parent and are introduced deliberately.

| Path | Change | Exact responsibility |
| --- | --- | --- |
| `src/types/config.ts` | MODIFY | Extend Phase-2 `OcxHubConfig` with the disabled/enabled `hub.managementIngress` union and document loopback-only semantics. Do not duplicate Phase-1 `runtimeRole` or Phase-2 `managementPublicOrigin` / `remoteGui` types. |
| `src/config.ts` | MODIFY | Parse the ingress opt-in, degrade malformed hand edits to disabled on load, and reject invalid live writes and port collisions. |
| `src/server/index.ts` | MODIFY | Compose the management listener using the existing optional-listener transaction, route allowlist, per-listener policy, rollback, and shutdown list. No body-level `await` may be added between the main `Bun.serve` and synchronous Lab activation. |
| `tests/loopback-listener-admission.test.ts` | MODIFY | Extend the existing optional-listener config/policy sibling tests for management-ingress defaults, role gate, and collisions. |
| `tests/loopback-listener-integration.test.ts` | MODIFY | Extend the existing real-socket sibling tests for bind address, GUI+/API allowlist, rollback, and all-listener shutdown. |
| `tests/server-management-auth.test.ts` | MODIFY | Prove ingress-scoped Tailscale identity, allowlist outcomes, pairing fallback, and the admin-token consent refusal. |
| `tests/service.test.ts` | MODIFY | Add only characterization needed by the documented hub install: systemd/launchd still read the protected token path and never embed the token. Do not change service generation. |
| `tests/oauth-manual-code.test.ts` | MODIFY | Exercise the existing manual-code route through the new management ingress; retain malformed/oversized negatives. |
| `tests/core-lab-boundary.test.ts` | VERIFY ONLY | Existing import-graph and synchronous-window guard must remain green; do not weaken it. |
| `docs-site/src/content/docs/guides/remote-hub.md` | NEW | Canonical English hub/client deployment guide: service, Tailscale, Docker, OAuth, health/readiness, rollback, and consent warning. |
| `docs-site/astro.config.mjs` | MODIFY | Add `guides/remote-hub` to Guides navigation. Phase 6 fills all configured locale labels/pages. |
| `structure/01_runtime.md` | MODIFY | Record the third listener as an opt-in composition-root concern and the service reuse decision. |
| `structure/05_gui-and-management-api.md` | MODIFY | Replace the loopback-only remote-GUI description with the final ingress-scoped issuance contract; preserve the admin-token boundary. |
| `structure/06_docs-and-release.md` | MODIFY | Record that Phase 5 ships a docs recipe, not an official Docker image/release channel. |

Explicitly unchanged: `src/service.ts`, `src/lib/service-secrets.ts`,
`src/server/management/oauth-account-routes.ts`, `src/router.ts`,
`src/server/lifecycle.ts`, and `src/server/responses/core.ts`. Their current behavior is
reused and verified, not copied.

## 3. Config and function contract

### 3.1 Config keys

Phase 1 owns `runtimeRole`; Phase 2 owns `hub.managementPublicOrigin` and
`remoteGui.allowedTailscaleUsers`. (`remoteGui.allowInsecureHttp` was removed from the
Phase-2 contract; a persisted `true` grants nothing.) Phase 5 adds only:

```ts
export interface OcxHubConfig { // existing Phase-2 interface, shown extended
  // Phase 2 field, shown for nesting only.
  managementPublicOrigin?: string;
  managementIngress?:
    | { enabled: false }
    | { enabled: true; port: number };
}
```

Contract:

- Missing and `{enabled:false}` are identical: no socket, no header trust, no new route.
- `{enabled:true}` is valid only when `runtimeRole === "hub"` and `port` is an integer in
  `1..65535` distinct from `config.port` and from an enabled
  `unauthenticatedLoopbackListener.port`.
- The hostname is not configurable. The socket always binds `127.0.0.1`; accepting a
  caller-provided hostname would destroy the Tailscale-header trust argument.
- A malformed hand edit disables only this optional listener on read. `ocx config set` /
  management writes fail with a concrete `schema_invalid: hub.managementIngress...` error.
- `managementPublicOrigin` is still the canonical browser-facing origin. Forwarded headers
  never synthesize it.

### 3.2 Listener integration signatures

Keep helpers private to `startServer` unless a direct unit seam is already established by the
Phase-2 implementation:

```ts
type ServerIngress = "public" | "unauthenticated-loopback" | "hub-management";

function managementIngressRouteAllowed(url: URL, req: Request): boolean;
function ingressForServer(server: Server<WsData>): ServerIngress;
```

Use the exact Phase-2 context and facade; do not create a second session API:

```ts
export function issueGuiSession(
  req: Request,
  config: OcxConfig,
  state: ManagementAuthState,
  context?: GuiSessionRequestContext, // { trustedTailscaleIngress: boolean; now?: number }
): GuiSessionBootstrap | null;
```

Pass `{trustedTailscaleIngress:true}` only when `requestServer === managementIngressServer`.
Every public/ordinary-loopback call passes false. The load-bearing fact is that the trusted
context is selected by a separately bound loopback socket; never infer it from Host, Origin,
`Forwarded`, `X-Forwarded-*`, or `Tailscale-User-*`.

### 3.3 Management listener route allowlist

The listener is GUI + management API only:

- `GET`/`HEAD` packaged GUI assets and `/`.
- `GET` extensionless SPA routes that the existing GUI fallback serves.
- `GET /opencodex-session` bootstrap and `POST /opencodex-session` pairing exchange.
- `/api/*`, with existing management authentication, Origin, session, CSRF, body-size, and
  route authorization intact.
- Everything else is deterministic JSON 404 before a handler runs, including all `/v1/*`,
  `/healthz`, `/readyz`, WebSocket upgrades, and unknown static paths.

The public listener remains the health/readiness/data endpoint. This prevents Tailscale Serve
from becoming an accidental unmetered data-plane proxy.

### 3.4 Startup and shutdown transaction

Reuse the shape at `src/server/index.ts` around the existing public + unauthenticated-loopback
bind:

1. Bind the public listener.
2. Bind the existing unauthenticated loopback listener when enabled.
3. Bind the hub management listener when enabled.
4. If either optional bind fails, synchronously initiate stop on every listener already bound,
   preserve the original bind error, and throw. Do not add `await` to `startServer`.
5. Add every successfully bound optional server to the existing `server.stop` closure so the
   shutdown promise joins all stops before background lifecycle release.
6. Log only bind address/port and mode. Never log identity headers, tokens, pairing codes, or
   public-origin query strings.

## 4. Existing service installer: Linux and macOS

No `src/service.ts` implementation change is warranted. Verified owners:

- `buildPlist(proxyEnv?)` in `src/service.ts` builds launchd and calls the common
  `buildServiceShellCommand`.
- `buildUnit(proxyEnv?)` builds the systemd user unit and calls the same command.
- `buildServiceShellCommand` reads `serviceApiTokenFilePath()` into
  `OPENCODEX_API_AUTH_TOKEN` at process start.
- `assertServiceAuthEnvironment()` refuses a non-loopback install without a token.
- `writeServiceApiTokenFile()` writes the token owner-only; unit/plist tests already assert
  that the literal secret is absent.
- Windows additionally carries `OCX_API_TOKEN_FILE` in the generated wrapper at the current
  `src/service.ts:1571+` path, but Windows deployment is not exercised here.

Canonical hub setup shown in the guide (values are examples, not defaults):

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set corsAllowOrigins '["http://localhost:10100"]'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'

# Read from a protected shell/secret manager; never put the token on argv.
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
ocx service status
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
```

The guide must say that the `openssl` command is an operator-side example, not a source of
provider credentials, and that `service install` copies the value into the existing protected
token file. `ocx config show`, unit/plist output, screenshots, and support bundles must never
contain it.

## 5. Tailscale Serve and ts.net certificate walkthrough

### Recommended: Tailscale Serve

```bash
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

Expected public browser origin is the exact HTTPS `https://<machine>.<tailnet>.ts.net`
configured in `hub.managementPublicOrigin`. The guide must require:

- `hub.managementIngress.enabled=true` and loopback bind proof before Serve is enabled.
- The user's exact Tailscale login in `remoteGui.allowedTailscaleUsers`; an empty list means
  no remote identity can mint a session.
- No cloud-firewall opening for port 10101. It is loopback-only.
- `tailscale serve`, not Funnel. Funnel is public internet and remains out of scope.
- A negative check that direct tailnet access to `:10101` fails and a positive check that the
  HTTPS page loads through Serve.

### Manual ts.net certificate path

For an operator-owned TLS proxy rather than Serve:

```bash
tailscale cert hub-name.tailnet-name.ts.net
```

The certificate names only the full ts.net FQDN. The guide must tell the operator to protect
the private key, renew it through Tailscale's supported mechanism, and proxy only to
`127.0.0.1:10101`. A generic TLS proxy does not supply trustworthy Tailscale identity headers,
so it uses the Phase-2 single-use pairing rung; it must not fabricate `Tailscale-User-*`.

Rollback:

```bash
tailscale serve reset
ocx config set hub.managementIngress '{"enabled":false}'
ocx service repair
```

The reset command removes all Serve mappings on that node, so the guide must instruct the
operator to inspect `tailscale serve status` first and use a narrower supported removal command
when unrelated mappings exist.

## 6. Docker recipe decision and contract

The new guide contains a full example Dockerfile but the repository does not ship or publish
one in Phase 5. The example is multi-stage, pins the Bun version to the repository's
`package.json` dependency (`1.4.0` at planning time), requires the operator to resolve and pin
the base image digest, builds `gui/dist`, copies only package/runtime files plus installed
dependencies, and ends as the image's non-root `bun` user.

Runtime contract:

```text
working directory       /home/bun/app
OPENCODEX_HOME           /home/bun/.opencodex
persistent volume       /home/bun/.opencodex
secret mount            /run/secrets/ocx_api_token (0400/0440)
OCX_API_TOKEN_FILE       /run/secrets/ocx_api_token
published data port     10100 only
management ingress      127.0.0.1:10101 inside the container; expose only through an
                        explicitly co-located tailnet/TLS topology
process                  bun run src/cli/index.ts start --port 10100
```

The example must include:

- `USER bun` (or an explicit numeric non-root uid/gid) in the final stage.
- No token in `ARG`, `ENV`, `COPY`, image history, Compose YAML, or command line.
- A named volume for `/home/bun/.opencodex`; deleting/replacing the container retains state.
- A liveness probe to `/healthz` and a separate readiness promotion check to `/readyz`.
- A data-authenticated `GET /v1/catalog` probe after ready, then one real routed response.
- `--read-only` where feasible, with writable volume and tmpfs exceptions.
- No Docker socket, host home, Codex home, SSH agent, or provider-key bind mount.

If the secret is absent/unreadable, a non-loopback hub must fail before being accepted as
ready. A 200 `/healthz` alone is never deployment proof.

## 7. Headless OAuth walkthrough

The server behavior is reused from `src/oauth/open-browser-choice.ts` and
`src/server/management/oauth-account-routes.ts:208`; no new OAuth route is added.

```bash
ocx config set oauthOpenBrowser false
```

Flow:

1. From the authenticated remote GUI or management client, call `POST /api/oauth/login`
   with the provider. The hub returns the authorization URL/instructions and does not invoke
   a browser on the hub.
2. Open the URL on the operator's machine and complete authorization.
3. When the loopback callback cannot reach the hub, paste the final redirect URL or code into
   the GUI/CLI, which sends `POST /api/oauth/login/code` with
   `{provider,input}`.
4. Poll the existing status endpoint until complete. Never paste the code into shell argv,
   logs, issue text, screenshots, or dogfood evidence.
5. Verify a routed request, not merely the OAuth status.

The route keeps its existing 409 for no active flow/invalid code, 400 for unknown provider,
and 4096-character cap. Tailscale session issuance changes neither provider allowlisting nor
OAuth credential persistence.

## 8. `clisu-oracle` dogfood runbook

### 8.1 Safety and isolated homes

- Use a dedicated branch worktree and dedicated `OPENCODEX_HOME` on `clisu-oracle`.
- Inventory existing listeners/services before selecting ports. Do not stop an unrelated
  production proxy.
- Keep the main hub port on the Tailscale address and the management ingress on
  `127.0.0.1`; do not open a cloud firewall rule.
- Record the exact git SHA, `ocx --version`, `/readyz` protocol fields, and client package
  version before traffic.

Branch deployment shape:

```bash
ssh clisu-oracle
git -C ~/Developer/opencodex fetch origin codex/remote-hub-design
git -C ~/Developer/opencodex worktree add ~/ocx-dogfood/remote-hub FETCH_HEAD
cd ~/ocx-dogfood/remote-hub
bun install --frozen-lockfile
bun run build:gui
export OPENCODEX_HOME="$HOME/.opencodex-remote-hub-dogfood"
# Apply the §4 config with clisu-oracle's Tailscale IP/FQDN and protected token.
bun run src/cli/index.ts service install
```

The implementation turn must replace `FETCH_HEAD` with the recorded exact SHA before declaring
evidence; the sketch above is setup, not exact-head proof.

### 8.2 MacBook connect and remote session

1. On the hub, run `ocx gui pair --origin http://localhost:10100` and copy the single-use,
   short-TTL code through the interactive channel. Do not record it.
2. On the MacBook, run the Phase-3 connect command with exactly one transient
   `--pairing-code-stdin` or `--admin-token-stdin`; it must not accept a literal secret flag.
3. Assert `ocx connect status --json` reports protocol v1, hub URL, management URL,
   management transport, and the non-secret client key id.
4. Assert `serviceApiTokenFilePath()` exists owner-only and contains the auto-issued per-client
   data key; `config.toml` contains only the env-key reference.
5. Open `http://localhost:10100`, mint the remote session through HTTPS or the fixed relay,
   and prove an ordinary management route works.
6. Prove a consent route is 403 with the admin token and succeeds only with the remote
   `gui-session` + matching browser origin + CSRF.

### 8.3 Per-machine usage slice

1. Create traffic from the MacBook client key and from a second distinct client key.
2. Capture the MacBook's non-secret `apiKeyId` from connect status.
3. In connected mode, assert the Usage page reads the hub store and defaults to only that id;
   the hub-wide toggle must show both clients.
4. Disconnect while the hub is reachable, then make one local standalone request.
5. Assert the disconnected Usage page reads local `usage.jsonl`, contains only local traffic,
   and does not contain mirrored connect-period rows.
6. Reconnect and assert the earlier MacBook slice still exists on the hub.

Counts, key ids, and timestamps may be recorded. Raw usage rows and all credentials may not.

### 8.4 Release ↔ dev protocol smoke

Two directions are mandatory once the latest published release contains protocol v1 and the
remote client commands:

| Hub | Client | Expected |
| --- | --- | --- |
| Branch/dev build on `clisu-oracle` | `@bitkyc08/opencodex@latest` on MacBook | Same-major connect, catalog sync, one routed request, remote session. |
| `@bitkyc08/opencodex@latest` in a second isolated home/port | Branch/dev client on MacBook | Same-major connect with feature detection; unsupported optional features stay disabled. |

Activation grounding: the 2026-08-28 tree has no released `connect` command. Therefore a current
pre-v1 `@latest` cannot construct either row and must not be reported as a pass. Before the first
v1 release, use a release-shaped `npm pack` candidate only as preflight evidence and label it
`candidate`, not `latest-release`. Phase 5 reaches terminal acceptance only after either (a) a
published protocol-v1 release makes both rows constructible or (b) the maintainer explicitly moves
the live release-pair gate to the post-release Phase-6 outcome while retaining the skew contract
tests. No silent substitution is allowed.

## 9. Test plan and activation matrix

Existing sibling files to extend are named in §2. Do not create a broad generic
`remote-hub.test.ts` that duplicates their established real-socket/auth/service harnesses.

| Conditional path | Constructible activation | Required observation / owner test |
| --- | --- | --- |
| ingress missing/disabled | Hub config omits it or sets false | Exactly one fewer `Bun.serve`; public behavior byte-compatible. `loopback-listener-admission`. |
| ingress on non-hub | `runtimeRole=standalone|client`, enabled true | Write-time schema rejection before bind. `loopback-listener-admission`. |
| valid ingress | Hub + unique port | Socket binds only `127.0.0.1`; GUI, SPA, bootstrap, and authenticated `/api` work. `loopback-listener-integration`. |
| disallowed route | Request `/v1/catalog`, `/readyz`, WS upgrade, or unknown path on ingress | JSON 404 before route handling; no provider call. `loopback-listener-integration`. |
| port collision | Match public or unauthenticated-loopback port | Config rejection before startup. `loopback-listener-admission`. |
| optional bind failure | Occupy ingress port before `startServer` | Startup throws original error and every earlier listener becomes rebindable. `loopback-listener-integration`. |
| normal shutdown | Enable all three listeners, then `server.stop(true)` | All three ports become rebindable; lifecycle release happens once. `loopback-listener-integration`. |
| spoofed Tailscale header on public listener | Send allowlisted identity header to main bind | No remote session. `server-management-auth`. |
| Tailscale allowlist match on ingress | Hub ingress + HTTPS public origin + allowed identity | Session minted with server/browser origins and ingress issuance. `server-management-auth`. |
| empty/wrong allowlist | Ingress request with absent or nonmatching identity | No session; admin token still cannot exchange. `server-management-auth`. |
| pairing via generic TLS proxy | Valid one-use origin-bound grant, no Tailscale identity | Session minted once; replay fails. `server-management-auth`. |
| service token present | Non-loopback hub + env token + install builder | Protected token path referenced; literal absent from unit/plist. `service.test`. |
| service token absent | Non-loopback hub, no env/file token | Install refuses before registration. `service.test`. |
| headless OAuth | `oauthOpenBrowser=false`, active provider flow | URL returned, no server-side open, manual code accepted. `oauth-manual-code`. |
| bad manual code | Unknown provider, no active flow, or >4096 input | Existing 400/409 response; no credential mutation. `oauth-manual-code`. |
| Docker secret missing | Non-loopback container without mounted token | Not ready / startup refusal; never accept health alone. Deployment smoke. |
| connected usage | Two client ids create hub traffic | This-machine slice and hub-wide toggle differ; hub store only. Dogfood. |
| disconnected usage | Disconnect then local standalone traffic | Local store only; no mirrored hub rows. Dogfood. |
| protocol same-major | Constructible v1 release/dev peers | Both directions connect with feature detection. Dogfood + Phase-6 skew tests. |

## 10. Acceptance criteria

- [ ] Default standalone and hub-with-ingress-disabled startup remain byte-compatible at the
  public listener.
- [ ] Management ingress is kernel-bound to `127.0.0.1`, default-deny, and serves no data,
  health, readiness, or WebSocket route.
- [ ] A failed optional bind rolls back every prior bind; normal stop joins every listener.
- [ ] `src/server/index.ts` remains synchronous through the guarded startup window and no new
  subsystem enters the three core import graphs.
- [ ] Tailscale identity is accepted only on management ingress and only for an exact configured
  user; admin-token-only consent remains 403.
- [ ] launchd/systemd installs use the existing secret-file flow and prove serving, readiness,
  authenticated catalog, and a real routed response.
- [ ] Docker recipe is non-root, volume-backed, secret-file-based, and checks liveness +
  readiness + authenticated functionality.
- [ ] Headless OAuth completes without opening a hub browser and produces a usable provider
  route.
- [ ] `clisu-oracle` dogfood proves MacBook connect, remote session, machine usage slice,
  disconnect/local-store behavior, and rollback.
- [ ] Release/dev compatibility is either genuinely run with a protocol-v1 published peer or
  explicitly remains a named, non-waived gate per §8.4.
- [ ] No token, pairing grant, OAuth code, email, account id, request body, or raw usage row is
  present in git diff or evidence.

## 11. Verification — remote only

Do not run any command below locally. Use an isolated checkout on `lidge-ai` at the exact SHA.

```bash
VERIFY_SHA="$(git rev-parse HEAD)"
ssh lidge-ai "set -eu
  export PATH=\$HOME/.bun/bin:\$PATH
  repo=\$HOME/ocx-verify/remote-hub-p5
  git -C \$repo fetch origin
  git -C \$repo checkout --detach $VERIFY_SHA
  test \"\$(git -C \$repo rev-parse HEAD)\" = \"$VERIFY_SHA\"
  cd \$repo
  bun install --frozen-lockfile
  bun run typecheck
  bun test tests/loopback-listener-admission.test.ts \
    tests/loopback-listener-integration.test.ts \
    tests/server-management-auth.test.ts \
    tests/service.test.ts \
    tests/oauth-manual-code.test.ts \
    tests/core-lab-boundary.test.ts
  cd docs-site
  bun install --frozen-lockfile
  bun run build
"
```

Then execute §8 on `clisu-oracle`; record exact SHA/version, sanitized protocol fields, HTTP
statuses, key ids/counts, and rollback result. A green `lidge-ai` suite does not replace the
deployment smoke, and a green `/healthz` does not replace ready/catalog/routed/session proof.
