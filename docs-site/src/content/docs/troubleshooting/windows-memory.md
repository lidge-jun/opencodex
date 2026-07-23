---
title: Windows Memory Growth
description: Why the bun process can grow to many gigabytes of RAM on Windows, what opencodex does about it today, and your options until the upstream Bun fixes ship.
---

Some Windows users see the `bun` process behind opencodex grow to many
gigabytes of RSS during long streaming sessions (reported as issue
[#314](https://github.com/lidge-jun/opencodex/issues/314)). This page explains
what is actually happening and what you can do about it, honestly.

## Root cause: upstream Bun runtime issues

opencodex bundles the Bun runtime (currently **1.3.14**). The memory growth is
driven by known upstream Bun issues, not by JavaScript-level leaks in the
proxy:

| Bun issue | State (checked 2026-07-23) |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — `fetch()` receive backpressure not coupled to JS consumption | Fixed by [PR #29831](https://github.com/oven-sh/bun/pull/29831); **which release carries it is unverified** — we assume the bundled 1.3.14 does not |
| [#32111](https://github.com/oven-sh/bun/issues/32111) — crash when a client aborts an async-pull stream | Fix [PR #32120](https://github.com/oven-sh/bun/pull/32120) merged 2026-06-21; not assumed present in 1.3.14. Note: this crash is **not Windows-specific** (it also reproduced on macOS/Linux) |
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — `node:net` socket handle leak | Still **open** upstream |

On Windows, opencodex must keep streaming responses on a conservative code
path to avoid the #32111 crash, and that path is the one most exposed to the
backpressure issue: a slow or stalled client can leave the runtime buffering
upstream data in native memory that JavaScript cannot bound.

## What opencodex does today

Bounded mitigation and visibility — **not a fix**. On the bundled 1.3.14
runtime the leak itself remains an upstream problem:

- **RSS watchdog** — the proxy samples its own memory every minute and logs a
  rate-limited warning when RSS crosses 4 GiB.
- **`ocx doctor`** — a "Memory / runtime" section shows the *service*
  process's Bun version, RSS, JS-heap share, and stream-mode decision, and
  tells you whether growth looks native-side (the upstream issue) or JS-side
  (an opencodex bug you should report).
- **`GET /api/system/memory`** — the same data over the authenticated
  management API for dashboards or scripts.
- **A gated alternative stream path** — a bounded single-reader relay that
  removes the unbounded buffering shape entirely. It becomes the default
  automatically once a bundled Bun release verifiably carries the #32111 fix;
  today it is opt-in only (see below).

Real-world RSS improvement from these changes is **awaiting verification by
Windows users** — we do not claim the leak is fixed.

Threshold-based auto-restart is deliberately **not** shipped. If the process
crashes, the service managers (Task Scheduler/WinSW, launchd, systemd) already
restart it.

## Your options

1. **Wait for a bundled runtime update.** Once a Bun release verifiably
   carries the fixes, opencodex will bump the bundled runtime and the safer
   stream path turns on automatically.

2. **Run a Bun runtime you trust with `OPENCODEX_BUN_PATH`.** This is
   unvalidated territory — you are running opencodex on a runtime we have not
   tested; at your own risk. Important for service installs: the override is
   read **when the service artifact is generated**, not at service start. Set
   the environment variable, then re-run `ocx service install` from that same
   shell so the path is baked into the durable service definition. Setting
   the env alone does nothing for an already-installed service.

3. **Opt into the bounded relay with `streamMode: "eager-relay"`.** Two ways:
   edit `config.json` (add `"streamMode": "eager-relay"`), or call the
   management API — a `PUT /api/settings` with `{"streamMode":"eager-relay"}`
   applies to new turns without a restart. **Crash risk warning:** on Bun
   1.3.14 this uses the stream shape affected by #32111, which can crash the
   process mid-stream (on any OS, not just Windows). The service manager will
   restart it, but in-flight requests fail. `"legacy-tee"` pins the current
   default; `"auto"` (default) lets the runtime gate decide.

If you try any of these on a real Windows workload, please report the before
and after `ocx doctor` memory sections on
[#314](https://github.com/lidge-jun/opencodex/issues/314) — that is exactly
the verification this mitigation is waiting on.
