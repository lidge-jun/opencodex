# 030 — #2107: service unit drops outbound proxy env

Rank 2.

## Failure mechanism

The title says "502 after service install in WSL", and both obvious readings
are wrong. Codex **did** reach OpenCodex; OpenCodex could not reach ChatGPT.

`buildUnit()` (`src/service.ts:2418-2444`) bakes exactly `OCX_SERVICE`, Bun
provenance, `PATH`, `CODEX_HOME`, `CODEX_SQLITE_HOME`, `OPENCODEX_HOME`. No
`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`. systemd does not
inherit the installing shell's environment.

`ExecStart=/bin/sh -lc` (`service.ts:457`) makes it worse in a way that is easy
to miss: on Ubuntu WSL `/bin/sh` is dash, and login dash reads `.profile`, not
`.bashrc` — where proxy exports usually live.

`applyProxyEnv()` (`src/config.ts:3441`) only fills from `config.proxy`, so a
shell-only proxy is invisible to the service.

Result: outbound TLS goes direct, the socket is reset,
`fetchWithResetRetry` exhausts (`src/lib/upstream-retry.ts:175`), and
`core.ts:2587` returns **502 `Provider unreachable`** with
`recoveryKinds: ["connection-reset"]`.

## How to tell it apart from #2108

The status code is the discriminator, and it is worth writing down because the
two reports look identical in prose:

| | #2107 | #2108 |
|---|---|---|
| status | **502** | **503** |
| body | `Provider unreachable` | `native-main profile maintenance is active` |
| log | `recoveryKinds: ["connection-reset"]` | native-main gate |
| cure | shim/direct start, or set `config.proxy` | `ocx restart` |

## Why the shim works and the service does not

`src/codex/shim.ts:692` runs `ocx ensure` in the interactive Codex shell, and
`src/cli/index.ts:431` spawns with `{ ...process.env }` — so `.bashrc` proxy
vars survive. That asymmetry is the whole bug.

## Fix shape

Bake the proxy keys into the generated unit, reusing what already exists:
`PROXY_ENV_KEYS` from `src/lib/proxy-env.ts` and the existing
`systemdEnvironmentAssignment()`.

The same hole exists in `buildPlist` (`service.ts:392-407`) and the Windows
wrapper (`service.ts:1516-1533`). Fix all three in one change — they are the
same omission, and splitting them means two more reports.

**Rules the implementation must follow:**

- Do not emit empty `Environment=` lines for unset keys.
- Keep loopback on `NO_PROXY` the way `applyProxyEnv()` already does, or the
  proxy will hairpin its own dashboard traffic.
- Do **not** switch `ExecStart` to an interactive `bash -ic`. That would fix
  the symptom by making service startup depend on the user's interactive shell,
  which is worse than the bug.

**Two risks to state in the PR rather than discover later:**

1. A WSL `WIN_HOST=$(ip route ...)` value is snapshotted at install time and can
   change after `wsl --shutdown`.
2. Proxy URLs can carry credentials, and baking them writes those into a unit
   file on disk. That is a privacy decision, not a detail — either redact, or
   prefer `config.proxy` and document why.

**Files:** `src/service.ts`, `tests/service.test.ts`.

## Regression test

With `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` set, `buildUnit()`
contains the matching `Environment=` lines; with them unset, those keys are
absent. Fails on current `dev`.

## Verification

```
bun test tests/service.test.ts
bun x tsc --noEmit
```

## Documented workaround for the issue thread

Set OpenCodex `config.proxy` — service start still runs `applyProxyEnv()`, so
this works today without any code change. `ocx doctor` already prints
"Current doctor process proxy env" vs "Running proxy process proxy env"
(`src/cli/doctor.ts:859`), which is the fastest way for a user to confirm the
diagnosis themselves.
