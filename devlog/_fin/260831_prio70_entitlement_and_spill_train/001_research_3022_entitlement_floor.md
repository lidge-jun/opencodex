# 001 — #3022: the entitlement client_version floor is below what upstream honours

Verified against `origin/dev` `870a2adb6` (package 2.37.0).

## The two defects

This issue is two defects wearing one symptom. Fixing either alone leaves the
other able to reproduce it.

### Defect A — the derived floor is wrong

`resolveCodexEntitlementClientVersion` has three tiers
(`src/codex/model-entitlements.ts:122`): inbound request version, persisted
runtime `selectedVersion`, then `GATED_MODEL_CLIENT_VERSION_FLOOR`.

Tier 3 is derived from the bundled snapshot, not hardcoded
(`src/codex/model-entitlements.ts:59`, `:81`, `:83`):

```
GATED_MODEL_CLIENT_VERSION_FLOOR = deriveGatedClientVersionFloor(snapshot) ?? FALLBACK
```

Measured in-tree:

```
GATED_MODEL_CLIENT_VERSION_FLOOR -> 0.142.2

src/codex/data/upstream-models.json
  gpt-5.6-sol    minimal_client_version = 0.142.2   context_window = 372000
  gpt-5.6-terra  minimal_client_version = 0.142.2   context_window = 372000
  gpt-5.6-luna   minimal_client_version = 0.142.2   context_window = 372000
```

**The repository already contains a live measurement that contradicts its own
snapshot.** `devlog/_fin/260817_native_gpt56_1m_context/001_measurement_evidence.md`
records `GET /backend-api/codex/models?client_version=<v>` against a real Codex
login:

| client_version | rows returned |
| --- | --- |
| 0.60.0 | 0 |
| 0.142.2 | 5 — **no gpt-5.6** |
| >= 0.144.0 | 8 — includes sol/terra/luna |

and records the live rows as `minimal_client_version = 0.144.0`,
`context_window = 272000`. The reporter measurement on #2886 (0.142.2 -> 200
without gpt-5.6; 0.144.0 / 0.146.0 -> 200 with) independently reproduces this on
a different account and machine.

So the snapshot's `0.142.2` and `372000` are both stale — they are PR #31684-era
values. Deriving the floor from that file faithfully produces a version upstream
does not honour, and tier 3 recreates the very defect #2891 set out to fix.

**Raising `GATED_MODEL_CLIENT_VERSION_FLOOR_FALLBACK` fixes nothing.** The
expression is `derived ?? fallback`; derivation succeeds, so the fallback is
unreachable (`src/codex/model-entitlements.ts:83`). Confirmed by reading the
code, not assumed.

### Defect B — an empty roster is recorded as a confirmed negative

`parseAccountModels` returns a `Set` for any payload whose `models` is an array
(`src/codex/model-entitlements.ts:374`). `{"models":[]}` therefore yields an
**empty but non-null** `Set`. Rows filtered for `visibility === "hide"` or
`supported_in_api !== true` can empty it the same way.

`fetchAccountModels` then converts non-null into confirmation
(`src/codex/model-entitlements.ts:414`, `:420`):

```ts
expiresAt: now + (models ? MODEL_ROSTER_TTL_MS : MODEL_ROSTER_FAILURE_TTL_MS),
models: models ?? new Set(),
confirmed: models !== null,
```

An empty `Set` is truthy, so the account is marked `confirmed` **and** gets the
five-minute success TTL instead of the fifteen-second failure TTL. Downstream,
the account enters `confirmedAccountIds` with a set that lacks the gated slugs,
and every projection reads that omission as a decided denial
(`:547`, `:573`). Catalog sync then strips the gated bare and selector rows
(`src/codex/catalog/sync.ts:1579`, `:1616`) and runtime auth excludes the account
(`src/codex/auth-context.ts:458`).

**`models.size > 0` is not a sufficient guard.** The reported short roster
contains `gpt-5.5`, so the set is non-empty while every gated row is absent. The
distinction that matters is whether the roster was obtained under a version
capable of returning the gated rows at all.

## Why it reaches users

Tier 1 and tier 2 mask the defect. It surfaces on the path with neither: a
background catalog sync or convergence pass with no inbound request
(`src/codex/catalog/sync.ts:1834`, `src/codex/convergence.ts:409`) on a host
where no Codex runtime was ever resolved, so `codex-runtime.json` carries no
`selectedVersion`. That matches the #2886 reporter's clean-reinstall reproduction
on a machine with no `codex` CLI.

## Fix surface

`src/codex/model-entitlements.ts`, and the snapshot only if its stale metadata is
corrected as a separate concern.

1. Tier 3 must not be a bare snapshot derivation. Take
   `max(derived, independently-measured minimum)` so a stale snapshot can lower
   documentation but never lower the question we ask upstream. The numeric
   comparator at `:88` already supports this.
2. An empty usable roster must be unconfirmed and take the failure TTL.
3. A roster fetched under a version below the trustworthy minimum must not make
   omission authoritative for gated slugs.

## Must not change

- The fail-closed posture itself (#2550). Unknown stays ineligible; this unit
  makes *unknown* distinguishable from *denied*, it does not admit unknown.
- Per-account and per-version cache keys (`:269`) — collapsing them reintroduces
  cross-version evidence leakage.
- Inbound/runtime precedence. Hardcoding every request to one version would
  advertise models to genuinely older clients (`:100`).

## Open question carried forward

The roster contract has no completeness marker and no per-model denial field, so
omission is the only signal available pre-dispatch. Whether `0.144.0` is stable
across all accounts is unproven: both measurements used one credential each,
though they were different credentials on different machines and agreed.
