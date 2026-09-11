# 260904 — Gated client-version floor: a stale Codex CLI hides GPT-5.6

## Symptom

On a host running opencodex `dev` (2.43.0), `gpt-5.6-sol`, `gpt-5.6-terra` and
`gpt-5.6-luna` do not appear: not in the Codex catalog, not in `/v1/models`, not in the
dashboard model rows, not in the desktop projection. The account owns them. The same
account sees them from other installs.

A second, independent symptom on the same host: `~/.opencodex/codex-runtime-clamp.json`
records `removedEfforts: ["max","ultra"]` across the whole 5.6 family.

## Reproduction (2026-09-04, this host)

```text
~/.opencodex/codex-runtime.json  selectedVersion = "0.141.0"  source = "configured"
codex --version                   codex-cli 0.141.0
npm view @openai/codex version    0.153.2
~/.opencodex/codex-runtime-clamp.json  runtimeVersion 0.141.0, removedEfforts [max, ultra]
```

The installed CLI is twelve minor versions behind what upstream publishes.

## Mechanism

`src/codex/model-entitlements.ts` resolves the `client_version` it asks upstream with in
three tiers (`resolveCodexEntitlementClientVersion`, ~line 185):

1. the inbound request's own `client_version`;
2. the persisted `codex-runtime.json` `selectedVersion`;
3. `GATED_MODEL_CLIENT_VERSION_FLOOR` — composed as the highest of the snapshot-derived
   floor, the measured `MEASURED_GATED_CLIENT_VERSION_MINIMUM = "0.144.0"`, and the
   `"0.142.2"` fallback.

Upstream filters `GET /backend-api/codex/models` by that parameter. Measurement recorded in
`devlog/_fin/260817_native_gpt56_1m_context/001_measurement_evidence.md`, and independently
reproduced by the #2886 and #3022 reporters: `0.142.2` returns five models with no gpt-5.6;
`0.144.0` and above return the gated rows.

Tier 2 is unconditional. It hands back `0.141.0` — a real, probed, honest version that is
nonetheless below the floor upstream needs. Background discovery therefore asks a question
whose truthful answer contains no gpt-5.6, and the rows disappear.

PR #3035 (`4bdc0f6fb`) introduced the `0.144.0` measurement precisely to stop this, but wired
it into tier 3 only. Tier 2 was left to speak for itself.

## The shape of the defect

The clearest statement of the bug is a comparison of two hosts:

| Host | Tier 2 | Version asked | gpt-5.6 visible |
|------|--------|---------------|-----------------|
| No Codex CLI installed at all | absent | `0.144.0` (floor) | yes |
| Codex CLI 0.141.0 installed | `"0.141.0"` | `0.141.0` | **no** |

Having an old runtime is worse than having no runtime. That inversion is not a policy
anyone chose; it falls out of tier 2 being unconditional while tier 3 is floored. The fix is
to make the two tiers agree about the minimum question worth asking.

## Why the absence is not evidence

The codebase already agrees with this reasoning elsewhere. `fetchAccountModels` treats an
empty roster as unconfirmed on the 15s failure TTL rather than a confirmed denial, and
`codexModelEntitlementStateForRoster` returns `"unknown"` — not `"denied"` — when a gated
slug is missing from a roster fetched below its recorded minimum. Both guards fire correctly
here, which is why the models are merely invisible rather than actively denied. The guards
prevent a wrong answer; they cannot manufacture the right one. Only asking a better question
can do that.

## Two symptoms, two causes, one stale runtime

They must not be conflated:

- **Missing rows** is an *account entitlement* question answered by upstream, filtered by the
  `client_version` we send. Fixable by asking under the floor.
- **Missing `max`/`ultra`** is a *local runtime capability* question. `src/codex/catalog/effort.ts`
  probes `codex debug models --bundled` and intersects the effort vocabulary the installed
  binary understands. A 0.141.0 binary genuinely does not know those rungs, so clamping them
  is honest and must stay. Advertising an effort the local runtime cannot express is #2548
  from the opposite side.

This unit fixes the first and deliberately leaves the second alone.

## Alternative considered: detect a newer Codex App runtime

The owner asked whether opencodex could instead prefer a newer runtime shipped by the Codex
desktop app. Investigated and rejected for this unit:

- `src/codex/runtime.ts` enumerates candidates in priority order (environment, configured,
  shim, PATH, fallback) and deliberately sticks with the configured one; a newer candidate is
  reported as `newerAvailable`, never silently selected. Changing that is a separate policy
  decision about which binary drives sync and the clamp.
- On this host the desktop package is `OpenAI.Codex 26.825.6671.0`. That version line is not
  comparable to a codex-cli `0.14x` version, and the bundled executable's version metadata is
  blank. There is installation evidence but no trustworthy *version* signal.
- No cross-platform equivalent exists today.

So app detection would invent a new, unmeasured authority to work around a floor we have
already measured. The floor is the evidence-backed fix.

## Risk register (from the audit lanes)

1. **`unknown` becomes `denied`.** The resolved version is recorded on the cache entry and
   read back by `hasUnknownGatedAbsence` and `codexModelEntitlementStateForRoster`. If we ask
   at `0.144.0` and upstream still omits the model, the answer is recorded as a denial on the
   5-minute TTL instead of unknown on 15s. This is correct: we really did ask at an adequate
   version. It is a strengthening of negative authority, and it is honest only so long as the
   floor itself is honest.
2. **Positive answers under a version the local runtime does not match (#2548).** A model may
   be granted while the installed CLI is 0.141.0. This is acceptable because opencodex injects
   `model_catalog_json` — model availability is the proxy's question, and the runtime's own
   capability limits are enforced separately by the effort clamp, which stays untouched.
3. **Do not clamp anything persisted.** `selectedVersion` is real probe evidence consumed by
   runtime identity, catalog cache keys, `X-Codex-Version` and install provenance. The clamp
   must live only in the entitlement resolver.

## Existing coverage

Audited `tests/codex-model-entitlements.test.ts`: no current assertion flips under a tier-2
floor, because every exact-resolution test either has no runtime, or a runtime above the floor
(`0.145.1`, `0.147.3`), or supplies the old version as tier 1 inbound. The precise gap is
`inbound = null` plus a usable persisted version *below* the floor. That is the regression to
write.

## Work phases

- `010` — floor-aware tier 2 in the entitlement resolver, with regressions.
- `020` — projection verification on a stale-runtime host.
- `030` — landing: full suite, PR to `dev`, CI-green merge.
