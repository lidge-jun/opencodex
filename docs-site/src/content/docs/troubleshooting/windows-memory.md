---
title: Windows Memory Growth
description: Why the bun process can grow to many gigabytes of RAM on Windows, what opencodex does about it today, and your options until the upstream Bun fixes ship.
---

Some Windows users see the `bun` process behind opencodex grow to many
gigabytes of RSS during long streaming sessions (reported as issue
[#314](https://github.com/lidge-jun/opencodex/issues/314)). This page explains
what is actually happening and what you can do about it, honestly.

## Root cause: upstream Bun runtime issues

Older OpenCodex versions bundled Bun **1.3.14**. The issue table below records the investigation as of July 23, 2026; it is historical evidence, not a statement of current upstream issue status. The current package bundles Bun **1.4.4**, and the stream-capability gate recognizes stable Bun 1.4.0 or newer as carrying the async-pull cancellation fix. This does not prove that every source of Windows memory growth is resolved.

| Bun issue | State (checked 2026-07-23) |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — `fetch()` receive backpressure not coupled to JS consumption | Fixed by [PR #29831](https://github.com/oven-sh/bun/pull/29831); **which release carries it is unverified** — we assume the bundled 1.3.14 does not |
| [#32111](https://github.com/oven-sh/bun/issues/32111) — crash when a client aborts an async-pull stream | Fix [PR #32120](https://github.com/oven-sh/bun/pull/32120) merged 2026-06-21; not assumed present in 1.3.14. Note: this crash is **not Windows-specific** (it also reproduced on macOS/Linux) |
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — `node:net` socket handle leak | Still **open** upstream |

On older runtimes, Windows used the conservative tee path to avoid the async-pull cancellation crash; a slow client could still leave native buffering that JavaScript cannot bound. With the current stable runtime, Windows `auto` selects the bounded eager relay when no client rewrite is needed. An explicit `legacy-tee` keeps the old path. On macOS, `auto` still keeps tee and eager relay requires explicit opt-in. Inspect the selected runtime and actual stream-mode decision before diagnosing memory growth.

## What opencodex does today

Bounded mitigation and visibility help diagnose retention; they do not establish that every memory-growth report is fixed:

- **Memory watchdog** — the proxy samples its own memory every minute and logs a
  rate-limited warning when observed memory crosses 4 GiB. Observed memory is
  the largest of RSS, `external`, and `arrayBuffers` (not their sum), because
  Windows working-set/RSS counters can under-report committed external
  retention.
- **`ocx doctor`** — a "Memory / runtime" section shows the *service*
  process's Bun version, RSS, external/ArrayBuffers counters, JS-heap context,
  and stream-mode decision. On older Bun 1.3.14 runtimes, `heapUsed` /
  `jscHeap` alone are not a leak discriminator; compare observed memory with
  `responseState` and repeated samples before assigning an app-level leak.
- **`GET /api/system/memory`** — the same data over the authenticated
  management API for dashboards or scripts. Alongside RSS/heap/external counters
  it reports a scalar `responseState` block (entry count, total/largest
  serialized bytes, oldest-entry age) for the proxy's in-memory
  `previous_response_id` continuation store. This further attributes growth: a
  rising `responseState.totalBytes` under rising observed memory points at
  conversation retention (long `store:false` chains re-expanding each turn),
  whereas a flat `responseState` under rising observed memory points away from
  that store. The values are scalar-only — no request bodies, tokens, paths, or
  account identifiers — and the read is side-effect free (it never prunes or
  evicts). Spill-write health is reported separately inside that block:
  `spillWriteStatus` starts as `initial`, becomes `degraded` after a failed
  publication, and returns to `healthy` after the next successful publication.
  `spillWriteConsecutiveFailures`, the last failure time, and the last success
  time show whether failures are accumulating or recovering in the same process.
  The last failure is a fixed privacy-safe class such as `EACCES`, `ENOSPC`,
  `ETIMEDOUT`, or `EACLRETRYEXHAUSTED`; raw error messages and filesystem paths
  are never returned. `spillLastWriteFailureOrigin` adds a fixed origin or null:
  `retry_returned_timeout` means the existing second spill attempt returned a
  timeout; `timeout_memo_refusal` means the ACL helper refused through its
  remembered timeout state. Other failures use null. The cumulative
  `spillAclRetryReturnedTimeouts` and `spillAclTimeoutMemoRefusals` count terminal
  failed publications, not individual ACL commands or transient first attempts.
  When a new continuation does not fit under the 1 GiB spill ceiling, the proxy
  first evicts the oldest stored continuations to make room, as long as that can
  succeed; a continuation that cannot fit even then is refused. The cumulative
  `spillHeadroomEvictions` counts continuations evicted to make room, and
  `spillCapacityRefusals` counts continuations refused because the ceiling could
  not make room (each one is also a failed publication with class `ECAPACITY`).
  A rising `spillCapacityRefusals` while memory is healthy means the durable
  continuation set is full of space the proxy cannot reclaim — in-flight
  publications or files a failed delete left behind — rather than a memory problem.
  Success clears the failure streak but retains the last failure fields and
  cumulative counts; a later unrelated failure sets the last origin to null.
  These values are process-local, so compare snapshots from the same process.
  Neither origin identifies an OS command: the attempt budget can expire before
  a command starts, and an optional compliance inspection can run before a memo
  refusal. A separate process succeeding does not prove that the live process's
  memo recovered. These observations do not add retries, clear memos, weaken
  required ACLs, or automatically restart the service.

  These diagnostics stay on the authenticated management
  endpoint and are intentionally absent from `/healthz`, which remains a liveness
  signal. The dashboard's **Memory observability** card renders the memory and
  continuation-size fields from this endpoint and offers a confirm-gated
  **Drain & restart** action: it shows
  the current active-turn count, waits up to 60s for active turns (reusing
  the existing HTTP 503 JSON `server_restarting` + `Retry-After: 5` drain),
  then aborts any remaining turns.
  The running proxy owns restart authorization and drain coordination, then
  exits; an installed service manager launches the replacement when applicable.
  The action reports success only after a different, identity-verified process
  is healthy on the same port, without tearing down Codex injection. That is a
  longer, informed recycle than the short drain on `POST /api/stop`.

  For a scriptable snapshot of the complete authenticated payload, run
  `ocx observe memory --json`; the CLI forwards the same response-state fields.
- **A gated alternative stream path** — a bounded single-reader relay. On Windows, `auto` selects it when the supported runtime and response shape permit; explicit `legacy-tee` preserves the tee path. On macOS, `auto` stays on tee and `eager-relay` remains opt-in. Check the actual decision for the selected runtime.

Catalog metadata reads use the selected runtime's last confirmed bundled catalog.
Cold or changed selections refresh through asynchronous version/model probes, so
those probes do not hold the proxy event loop. Shared refreshes have a 45-second
deadline; failed request-triggered refreshes retain matching rows and apply a
60-second retry cooldown. Request abort releases translator accounting even
when a response body is unread. These liveness changes do not establish that
Windows native stream retention ([#6671](https://github.com/lidge-jun/opencodex/issues/6671)) is resolved.

Real-world RSS improvement from these changes is **awaiting verification by
Windows users** — we do not claim the leak is fixed.

Threshold-based auto-restart is deliberately **not** shipped. If the process
crashes, the service managers (Task Scheduler/WinSW, launchd, systemd) already
restart it.

## Your options

1. **Check the selected runtime and actual stream decision.** The current package bundles Bun 1.4.4 and the capability gate accepts stable releases from 1.4.0. Windows `auto` can already select bounded eager relay when applicable; another bundled update is not required to enable it. An explicit `legacy-tee` selection preserves tee. This does not prove every source of memory growth is fixed.

2. **Run a Bun runtime you trust with `OPENCODEX_BUN_PATH`.** Set the variable before launching `ocx` from that shell, then run `ocx service repair` to bake the selected runtime into the service definition. A later project `.env` does not change selection; changing the environment alone does not update an installed service.

3. **Select the bounded relay with `streamMode: "eager-relay"`.** Edit `config.json` (add `"streamMode": "eager-relay"`) or call `PUT /api/settings` with `{"streamMode":"eager-relay"}`; the API change applies to new turns without a restart. The Bun 1.3.14 crash warning is historical: that release used the stream shape affected by #32111 on any OS, interrupting in-flight requests even when the service restarted. `"legacy-tee"` explicitly forces the old tee path. On Windows, `"auto"` uses the runtime gate and response conditions; on macOS, `"auto"` stays on tee and `"eager-relay"` is the opt-in.

If you try any of these on a real Windows workload, please report the before
and after `ocx doctor` memory sections on
[#314](https://github.com/lidge-jun/opencodex/issues/314) — that is exactly
the verification this mitigation is waiting on.

## Windows selected-runtime write refusal

Windows service installation, repair and Codex shim installation/refresh check whether the selected executable can create and remove a directory inside the OpenCodex config root. This is a write-policy check, not a memory fix. Failure refuses before service stops, downloads, staging, token or launcher writes. Automatic shim repair is deferred with guidance and startup continues. Healthy or disabled shims do not probe. No alternate runtime is discovered. A first-time scheduler install registers its task and claims the config root before this check; on refusal that new registration is rolled back and the claimed root stays for a retry.

> The selected Bun runtime could not create and remove a directory in the OpenCodex config directory. Windows application policy may deny writes from this executable location. Set OPENCODEX_BUN_PATH to a trusted Bun executable allowed by your policy before launching ocx, or reinstall opencodex with npm install -g @bitkyc08/opencodex, then retry. No alternate runtime was selected.
