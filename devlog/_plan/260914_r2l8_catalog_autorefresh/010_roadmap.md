# R2-L8 — catalog auto-refresh and capability declarations

Lane R2-L8 of the round-23 delivery unit. Branch `codex/260914-l8-catalog-autorefresh`,
one pull request against `dev`. Write scope is the one the lane assignment fixed:
`src/codex/catalog-refresh-status.ts`, `src/codex/convergence.ts`, `src/config.ts`,
`src/types/config.ts`, `src/types/provider.ts`, `src/server/background-lifecycle.ts`
and their tests. L8 is wave A's only config-schema owner, so the schema edits stay
additive and self-contained.

## What the two issues actually need

**Periodic catalog auto-refresh (issue 3630).** A running proxy only re-discovers
provider models when someone runs `ocx sync` or restarts. The reporter watched a
newly released upstream model stay absent from `/v1/models` and from the on-disk
catalog until they remembered to sync by hand. The ask is a configurable interval
that drives the same converge path `ocx sync` drives, plus visibility when the
served model set actually changes.

**Per-model capability declarations (issue 3377).** The declaration half is already
on `dev`: `ModelCapabilities` in `src/types/provider.ts` carries `inputModalities`,
`contextTier` and `video.processing`; `src/config/provider-validation.ts` validates
and merges it; `ocx provider add`/`edit` accept it. Only the text-only axis is live —
`configuredInputModalities` in `src/codex/catalog/parsing.ts`'s neighbour
`catalog/provider-fetch.ts` reads it, and `src/vision/` honours it. `contextTier` and
`video.processing` are stored and inert, and both activation sites
(`src/providers/github-copilot-transport.ts`, `src/adapters/google.ts`,
`src/responses/schema.ts`) sit outside this lane's write scope. This lane therefore
does not close issue 3377; it pins the part it can own.

## Design

### Config surface

```ts
export interface OcxCatalogAutoRefreshConfig {
  enabled?: boolean;         // master switch, default false
  intervalMinutes?: number;  // default 60, floor 15, 0 keeps the timer dormant
}
```

on `OcxConfig.catalogAutoRefresh`. Opt-in rather than default-on: a refresh spends a
live `/models` call against every enabled provider, and the repository's existing
optional-subsystem rule is that a default install runs no detection code. The floor
exists for the same reason `src/quota/reset-poller.ts` has one — provider catalogs
are cached for minutes upstream, so a one-minute cadence buys nothing and costs a
rate limit.

Resolvers exported from `src/config.ts`:

- `isCatalogAutoRefreshEnabled(config?)` — true only when the section is present and
  `enabled === true`.
- `resolveCatalogAutoRefreshIntervalMs(config?)` — bounded milliseconds, or `0` when
  the operator disabled polling explicitly.

### Scheduler

New `src/codex/catalog-auto-refresh.ts`, shaped after `src/quota/reset-poller.ts`:
a module-singleton `setInterval` that is unref'd, an in-flight guard so a slow
provider fetch cannot stack ticks, and a generation counter so a probe still in
flight when the timer stops cannot publish into the next generation. The config gate
lives in the callee, which is what lets an operator toggle the setting without a
restart. Every heavy import — the config barrel, the catalog admission snapshot,
the convergence path — is a dynamic `import()` inside the tick, so importing this
module costs nothing at startup.

A tick captures a catalog admission snapshot and calls `convergeCodexCatalog` with
`{ scope: "catalog", action: "converge" }`, which is exactly the path `ocx sync`
uses. The existing "external provider owns config.toml" guard lives inside that
path, so it is respected by construction rather than re-implemented here.

### Observability

`src/codex/catalog-refresh-status.ts` gains a last-outcome record: when the refresh
ran, its normalized `CatalogDisposition`, whether the served model set changed, and
a consecutive-failure count. A tick that changes the model set logs one line. The
per-model "N new models discovered" count issue 3630 asks for is not delivered:
`convergeCodexCatalog` returns a boolean, not a diff, and widening its return type
reaches into the catalog writers this lane does not own. The dashboard surface for
this record belongs to R2-L9.

### Registration

`src/server/background-lifecycle.ts` starts and stops the scheduler alongside the
quota reset poller, and fires the cadence sync as a floating promise for the same
reason that one does: startup must not await an optional subsystem.

## Cycle plan

1. Docs cycle — this file.
2. Config schema and resolvers, with focused tests.
3. Scheduler, status record, and lifecycle registration, with focused tests.
4. Capability-declaration regression pinning that a periodic refresh preserves the
   declared axes, plus the `structure/config.md` update the SSOT rule requires.

## Verification posture

No local suite, no typecheck, no install, no GUI build. Hosted CI at the exact final
head is the only proof this lane reports.
