# 050 — Outcome

Unit: expose Codex Fast (the `priority` service tier) to external clients as a selectable
`<base-id>--fast` row. Branch `codex/260904-fast-row-core`.

## What shipped

| Work-phase | Commit | Surface |
|---|---|---|
| wp0 | af7fe0ad4 .. 5a7a7dc43 | the plan unit, eight audit rounds |
| wp1 | d8735ba25 .. 8c5cbc6a6 | `src/server/fast-row.ts`, `fastRows` flag, `isKnownId` export |
| wp2 | 3c1b4ae94 | `/v1/models` + both Claude discovery loops |
| wp3 | e44d62717 | five ingresses, alias-safe decoding, compact tier policy |
| wp4 | this commit | docs-site reference, this record |

## What the reviews changed

Eleven adversarial rounds across the plan and the code. The findings that changed the
design, rather than merely tidying it:

- **The separator.** A terminal `-fast` is already a real id (`grok-4-fast`,
  `glm-5.3-fast`, `gpt-5-fast`, every Cursor fast variant), so one hyphen cannot tell a
  product apart from a tier. Hence `--fast`.
- **The routable-base oracle.** Two wrong answers preceded the right one. Requiring
  membership in `knownEffortRowIds` would have published `gpt-5.6-sol--fast` and then
  refused to parse it, because bare natives declare no models list and route by family
  pattern. A config-only set then missed live-discovered and retained models. The answer is
  a predicate: a known static/config id, or an id namespaced under an enabled provider.
- **The stability claim.** My "stable for a given config" comment was false — the set read
  the live-model cache. My defence (the base row disappears too) was disproved with routing
  evidence: `/v1/models` is discovery, not a routing allowlist, and `routeModel` still
  serves the base after cache churn. Only the fast selector broke. Fixed at the source.
- **Default-off.** `buildAnthropicModelInfos` treats the predicate's PRESENCE as the gate,
  so passing it unconditionally would have enabled the feature on a default install.
- **Compact.** Writing only the `set` branch left a caller's stale `service_tier` riding
  along past a `drop`, through the native forwarding path — bypassing the `fastMode: false`
  suppression this phase exists to preserve.
- **The shipped neighbour.** The first parser wrapper rebuilt the effort-row logic inline and
  regressed `cursorEffortRows` for users with the new flag off. It now delegates to the
  shipped function verbatim.

## Verification

- `bun run typecheck` clean.
- 436 focused tests across ten files: `fast-row`, `fast-row-listing`,
  `fast-row-ingress`, `core-lab-boundary`, `claude-inbound`,
  `chat-completions-endpoint`, `responses-compaction`,
  `responses-compaction-routing`, `cursor-fast-tier`, `config`.
- `bun run privacy:scan` passed.
- No repository-wide local suite was run, per the operator's standing instruction.

One receipt run reported three failures that did not reproduce across three consecutive
re-runs or the final receipt (exit 0, bound to `e44d627`). Consistent with port contention
between parallel suites; recorded rather than silently discarded.

## Residuals

- **R1 — effort and fast do not compose.** `<base>--high--fast` is not published, and an id
  carrying both markers resolves to neither. A combined codec is deferred until someone asks
  for a specific effort at Fast; the base row's default effort already reaches Fast.
- **R2 — export surfaces emit base ids only.** `/api/models` `namespaced` ids feed
  `ocx export` and the OpenCode integration, and those identities are written into user
  config files that outlive the flag. Documented as a limitation rather than widened.
- **R3 — remote CI is unverified.** The branch is pushed but no PR has been opened, so
  criterion c-7 is open. The stacked-PR split described in `040` was not exercised: the
  work landed as one dependency-ordered branch.

