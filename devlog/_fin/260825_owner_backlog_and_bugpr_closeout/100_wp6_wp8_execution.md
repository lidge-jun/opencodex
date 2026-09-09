# 100 — wp6/wp8 execution record (issues #2569, #2565, #2566)

Cycle after the roadmap lock. Three maintainer-authored issues closed, each with its own PR
onto `dev`.

## #2569 — Cursor catalog drift (2 PRs)

**#2584** catalogued `gemini-3.6-flash` and `gemini-3.7-flash`, which the live roster
carries but the static catalog did not. Adding them exposed a second defect:
`gemini-3.6-flash` is the only Cursor model with a `minimal` rung, and
`cursorModelEffortLadder` filtered against the canonical five-rung order, so the tier was
dropped from the picker while `cursorEffortSuffix` would have sent it — declared but
unreachable.

**#2585** exposed the 13 `-thinking` families. `isCursorModelAvailableForAccount` matches a
base id against `{base}`, `{base}-{effort}` and the family wire form; no `-thinking` id
matches any of those, so all 46 thinking wire ids were invisible. The marker's position is
family-dependent and the wrong order is rejected `ERROR_BAD_MODEL_NAME`, so all three
shapes are modelled: thinking-then-effort, effort-then-thinking, bare.

Evidence: composed every catalogued id/tier pair against a live `GetUsableModels` roster —
46 matched, 0 mismatched. Visible models 41 → 52.

Not done, deliberately: the 13 static-only entries stay. They are the logged-out and
discovery-failure fallback, and `filterCursorConfiguredModelsByLiveDiscovery` already drops
them when live discovery succeeds.

## #2565 — `ocx provider quota` printed a count (#2586)

`quota()` rendered through `summaryLines()`, a depth-1 flattener that emits `N item(s)` for
a non-scalar array, so every fetched report was discarded. Now renders through
`providerQuotaLine`, the formatter `ocx account refresh` already uses.

## #2566 — per-account quota in `ocx account list` (#2587)

Server side already existed; the CLI never passed `quota=1`. Added `--quota` (opt-in,
because the server probes once per stored credential) and `--refresh`. Unprobed shows `-`,
failed probe shows `unavailable` — blank would read as "no usage" rather than "not
measured". Live proof on three Anthropic logins: active account 45% weekly while a sibling
sits at 98%.

## Self-inflicted regression, found and repaired

#2578 (my #2503 landing) made the catalog hint pass read `PROVIDER_REGISTRY`. A gather
flight captures its registry authority up front and forbids later reads, so every hint pass
became that forbidden read and a custom-destination flight lost its own discovery result.
Bisected: green at `4d3d2716e`, red from `844885ab1`. Repaired in #2582 by materializing the
default at seed time (`applyVerbosityDefaults`) and stripping it from saved config per the
#1100 invariant — whose test caught the first version of the patch.

