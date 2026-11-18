# wp5 — #8848: refuse real network egress from the test process

## Problem

43 test files reach real provider hosts through six source paths (issue #8848). Confirmed on
this host at the base: `claude-outbound` opens `wss://chatgpt.com`, `codex-account-threshold-api`
fetches `chatgpt.com/backend-api/wham/usage` and `auth.openai.com/oauth/token`, and
`gpt61-terra-provider-rows` reaches `api.githubcopilot.com` through `node:https` (invisible to
fetch mocks). `tests/preload.ts` installs no network guard.

## Decision

Guard first. A preload guard makes every leak a local connection failure, which is what an
offline runner already produces, so the 43 files keep their meaning without the fixture
credential leaving the machine. Files that then fail because they silently relied on the real
answer get a seam in the same commit. Converting all 43 files to stubs first would be a much
larger diff with the same end state.

## Diff

NEW tests/helpers/network-egress-guard.ts

- `isTestEgressAllowed(host)`: loopback (`127.0.0.0/8`, `::1`, `localhost`, `*.localhost`),
  wildcard `0.0.0.0`/`::`, IPv4-mapped loopback, and the reserved `.test`, `.example`,
  `.invalid` names (they fail in DNS and about 20 files rely on that); literal addresses of
  this machine's interfaces only after `allowOwnInterfaceAddressesForTest()`.
- `installNetworkEgressGuard()`: idempotent; wraps three entry points, measured in Bun 1.4.4
  with scratch probes:
  - `globalThis.fetch`: non-network schemes and `unix` pass; a loopback `proxy` option passes;
    otherwise rejects with `TypeError("test network guard refused <scheme>://<host>")`.
  - `globalThis.WebSocket`: a subclass; a refused URL is redirected to a `ws+unix` path that
    does not exist, which dispatches `error` then `close` (1006) in under a millisecond without
    any TCP connection; `ws+unix` and a loopback `proxy` pass.
  - `net.Socket.prototype.connect`: Bun routes `net.connect`, `tls.connect`, `http.request`,
    `https.request` and `http2.connect` through it, passing Node's normalized
    `[options, callback]` array as the first argument (the research note that node:https bypasses
    it hooked the wrong argument shape). A refused host destroys the socket with an
    `ECONNREFUSED` error on the next tick, which every caller already handles as a connection
    failure. Unix paths pass.
  Header values are never read or logged.

MODIFY tests/preload.ts: install the guard after the sandbox is in place.

MODIFY tests/helpers/native-profile-startup-child.ts: install the guard (the child runs without
the preload) and stop passing unmatched URLs to the real fetch.

MODIFY the `bun --eval` child of tests/codex-integration/codex-retained-root-serialization.test.ts
(only if it still reaches api.together.xyz under the guard): import the guard first.

MODIFY tests/server/loopback-listener-integration.test.ts: call
`allowOwnInterfaceAddressesForTest()` (it deliberately connects to this machine's own address).

NEW tests/ci-workflows/test-network-egress-guard.test.ts (+ layout registration):

- fetch, WebSocket, `https.request`, `net.connect` and `http2.connect` to `chatgpt.com` /
  `api.githubcopilot.com` are refused locally (error shape asserted, no response object).
- the production paths of the issue are refused: `fetchCodexUsage` (quota probe) and a
  `pinnedHttpGet` to a public host.
- loopback fetch, WebSocket and `node:http` to a local `Bun.serve` still work; a `.invalid`
  name keeps its DNS failure.
Without the guard the refusal assertions fail (the request reaches the host or resolves).

Then run all 43 files under the guard and fix the ones that fail; each fix is a seam, never a
loosened assertion.

## Audit residuals (folded)

- Named imports (`import { request } from "node:http"`) keep the original function, but every
  one of them still opens its socket through `net.Socket.prototype.connect`, which the guard
  patches; the guard does not depend on module-object patching at all. The named-import sites
  (`src/client/link-relay-transport.ts:1`, `src/client/link-ws-transport.ts:1`,
  `src/cli/update-restart-transport.ts:1`, `src/claude/intercept/picker-listener.ts:16`,
  `src/service/desktop-recovery.ts:4`, `src/lib/desktop-upstream-tunnel.ts:2`) are loopback today.
- Child processes run without the preload. 47 child/worker entrypoints exist under
  `tests/helpers/`; the guard is installed in the ones the issue measured leaking
  (`native-profile-startup-child.ts`, the `bun --eval` child of
  `codex-retained-root-serialization`). The rest stay a residual and are listed in the PR.
- 585 of 610 files that assign `globalThis.fetch` capture it at module load, after the preload,
  so their restore reinstalls the guarded function.

## Verification

- `bun test tests/ci-workflows/test-network-egress-guard.test.ts` red without the preload line,
  green with it.
- The 43 files of the issue, run with the guard.
- `bun run test:changed`; a harness change also selects the full Ubuntu shards in PR CI.
- NOT RUN: Windows and Linux locally.



