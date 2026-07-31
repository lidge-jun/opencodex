# 020 — WP2: Expose effort caps (Dashboard GUI + docs-site reference)

## Loop-spec

- Archetype: spec-satisfaction. Class C2 (conventional GUI slice + docs).
- Goal: both caps configurable from the Dashboard and documented in the configuration
  reference (en/ko/zh-cn).
- Non-goals: new API shapes (the /api/effort-caps contract from WP0 is frozen), cap
  semantics changes, guides restructuring.
- Verifier: `cd gui && bun run build` exit 0; `bun test` stays 0 fail; doc files exist
  with both keys documented.

## File change map

Two disjoint write scopes (parallel sol workers):

Amended after audit round 1 (3 blockers folded): German locale added (en.ts defines
TKey and every locale must satisfy Record<TKey,string> — missing de keys are tsc -b
build errors); cap options trimmed to low..xhigh (post-parse requests arrive low..max,
so a max/ultra cap never lowers anything); docs wording separates snap-down from strip.

Worker A — GUI (`gui/` only):
- `gui/src/pages/Dashboard.tsx`: new panel (same `panel` + `injection-head` pattern as
  the delegation panel) with TWO `Select`s — global cap (`effortCap`) and sub-agent cap
  (`subagentEffortCap`) — loaded from `GET /api/effort-caps` in the existing initial
  fetch effect (best-effort res.ok block like injection-model), saved via
  `PUT /api/effort-caps` sending only the changed key (per-key semantics; null clears),
  one shared saving flag, both states hydrated from each successful response.
  Empty option = no cap. Options: `low`, `medium`, `high`, `xhigh` only — post-parse
  requests arrive low..max (ultra converts to max), so a max/ultra CAP imposes no
  lower RANK ceiling and is excluded from the picker (backend still accepts the full
  low..ultra ladder; note a max/ultra cap can still trigger ladder-aware snap-down or
  strip on models with known ladders, e.g. resolveCappedEffort("max", ["xhigh"]) ->
  xhigh — round-2 audit precision).
- `gui/src/i18n/en.ts`, `ko.ts`, `zh.ts`, `de.ts`: keys `dash.effortCapLabel` ("Effort cap
  (all turns)" / "추론 강도 상한 (전체)" / "推理强度上限（全部）"),
  de: "Effort-Limit (alle Turns)";
  `dash.subagentEffortCapLabel` ("Effort cap (sub-agents)" / "추론 강도 상한
  (서브에이전트)" / "推理强度上限（子代理）", de: "Effort-Limit (Sub-Agents)"),
  `dash.effortCapNone` ("No cap" / "상한 없음" / "无上限", de: "Kein Limit").
  en.ts defines TKey; EVERY locale file must gain all three keys or `tsc -b` fails.

Worker B — docs (`docs-site/src/content/docs/**/reference/configuration.md` only, 3
locales en / ko / zh-cn):
- Add `effortCap?` and `subagentEffortCap?` rows to the Top level (`OcxConfig`) table
  next to `injectionEffort?`: ladder value low..max; hard ceiling rewritten per-request;
  subagent variant applies only to requests carrying codex-rs spawned-child markers
  (`x-openai-subagent` / turn-metadata `subagent_kind`); lower of both wins; caps only
  lower; accepted backend range documented as low..ultra (Dashboard recommends
  low..xhigh); "max and ultra do not impose a lower rank ceiling, though known model
  ladders may still cause snap-down or strip."; snap-down/strip wording: "Snaps down to the highest supported
  rung at or below the cap. If the model exposes no effort control, or no supported
  rung fits under the cap, the effort field is removed and the provider default
  applies."; unset = no cap.

## Accept criteria

- GUI builds (`cd gui && bun run build` exit 0); both selects render from one panel and
  persist through PUT (existing pattern, no new client abstractions).
- All three locale files gain BOTH keys with consistent wording; en/ko/zh-cn docs rows
  match the shipped semantics (strip behavior included).
- `bun test` remains 0 fail (no server-side changes in WP2).
