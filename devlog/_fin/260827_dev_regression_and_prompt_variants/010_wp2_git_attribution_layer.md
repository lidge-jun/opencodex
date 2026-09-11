# 010 — WP2: the `git_attribution` prompt layer, end to end

Diff-level. Every path and edit is named; the implementing cycle executes this
document after a stale check against the tree.

## Upstream truth (re-verified at write time)

`120_codex-cli/codex-rs/ext/git-attribution/src/world_state.rs`:

- `WORLD_STATE_ID = "git_attribution"`, markers `<git_attribution>` / `</git_attribution>`, role `developer`.
- Three bodies: `ENABLED_INSTRUCTIONS` (the `Co-authored-by: Codex` trailer plus the
  `Generated with Codex.` PR marker), `DISABLED_INSTRUCTIONS` (an explicit countermand),
  `LEGACY_COMMIT_ATTRIBUTION_INSTRUCTIONS` (matched for cleanup only).
- `ext/git-attribution/src/lib.rs:33-80`: enablement comes from
  `resolve_attribution_policy(auth_manager, base_url, http_client_factory)` — the AUTH
  SERVER — cached on the thread store, defaulting to `enabled: false` on failure.
- `features/src/lib.rs:277`: the old config flag is recorded as removed.

Therefore: no config key, no `[features]` entry, account-derived, and BOTH the enabled
and disabled bodies are reachable.

Verified against the live binary too: `codex debug prompt-input` (codex-cli 0.145.0)
emitted 32978 bytes containing `apps_instructions`, `environment_context`,
`permissions instructions`, `plugins_instructions`, `skills_instructions` — and **no**
`git_attribution`, no attribution text. That is consistent with a diff-rendered
world-state section emitting nothing when its state is unchanged from the previous
turn, already documented at `prompt-text-probe.ts:9-17`. It also means the probe
cannot supply this layer's body on a first turn, so the dialog must not claim it can.

## Changes

### 1. `src/codex/prompt-layers.ts`

MODIFY `LAYER_INVENTORY` (currently lines 88-104). Append one descriptor. Because the
section arrives through `extensions.context_contributors()`
(`core/src/session/world_state.rs:64-66`), its assembly position is registration-order
dependent, so `order` is `null`, and the row renderer already prints a neutral dot for
that case (`PromptLayerRow.tsx:60-63`).

```ts
  { id: "multi-agent-mode", class: "feature-gated", key: "features.multi_agent_v2.enabled", default: false, order: 14 },
+ // Contributed by ext/git-attribution, not by a config key. lib.rs:33-80 resolves
+ // enablement from the auth server and caches it per thread, so there is nothing
+ // for this GUI to write and nothing in [features] to point at. Order is null:
+ // it registers through extensions.context_contributors(), whose position is
+ // registration-order dependent rather than fixed in world_state.rs.
+ { id: "git-attribution", class: "runtime-conditional", key: null, default: null, order: null },
```

NO change to `TOGGLE_KEYS`. Adding it there would emit a key `config_toml.rs` does not
define; that file has no `deny_unknown_fields`, so the key is silently ignored in
normal mode and a hard startup error under `--strict-config`. The fixed-allowlist
comment at lines 106-112 already states this.

### 2. `src/codex/prompt-text-probe.ts`

MODIFY `UNMAPPED_LAYER_IDS` (lines 51-64). Add `"git-attribution"`.

It does NOT go in `LAYER_SECTION_TAGS`. The tag is real in the Rust source, but the
live probe above did not emit it, and that file's header is explicit that every entry
was read off live output and that inferring from Rust `ID` constants produced a wrong
mapping once already. An id absent from both maps is reported as unavailable rather
than as a fabricated body.

### 3. `gui/src/components/codex-set/prompt-layer-copy.ts`

Four edits, each in a map whose exhaustiveness the `LayerId` union enforces (the
stated point of that union at lines 12-27):

- `LayerId`: add `| "git-attribution"`
- `LAYER_LABEL_KEYS`: add `"git-attribution": "codexSet.layer.git-attribution"`
- `LAYER_ABOUT_KEYS`: add `"git-attribution": "codexSet.about.git-attribution"`
- `LAYER_CONDITION_KEYS` (partial by design, lines 74-80): add
  `"git-attribution": "codexSet.condition.git-attribution"`

The condition entry is mandatory, not optional: without it the row falls through to
`codexSet.row.alwaysOn`, and "always on" is false — DISABLED and ABSENT are both
reachable states.

### 4. `gui/src/i18n/en.ts` plus ja, ko, ru, zh-cn

Three new keys per locale. English authored first, the rest translated, per `004` §D of
the parent unit. lane-gui measured 2256 keys and 0 gaps per locale; that must still
hold afterwards.

- `codexSet.layer.git-attribution` — "Commit attribution"
- `codexSet.about.git-attribution` — tells the model to add the `Co-authored-by: Codex`
  trailer to commits it writes and `Generated with Codex.` to pull requests it opens;
  Codex resolves this from the account, so there is no setting here or in `[features]`;
  when the account turns it off Codex sends the opposite instruction rather than nothing.
- `codexSet.condition.git-attribution` — "Set by your account's attribution policy"

### 5. Tests

- `tests/codex-prompt-layers.test.ts` — inventory now has 16 entries; assert the new
  descriptor's exact shape and assert it is NOT in `TOGGLE_IDS`. The second assertion
  is the protective one: it fails if someone later makes the row writable.
- `tests/codex-prompt-route.test.ts` — the served inventory includes it.
- `gui/tests/codex-set-prompt-layers.test.tsx` — the row renders, shows the condition
  string, and renders NO element with `role="switch"`.

## Acceptance criteria, with activation scenarios

| # | Criterion | Trigger | Observable proof |
|---|---|---|---|
| 1 | Row appears | load the panel | `[data-layer-id="git-attribution"]` present |
| 2 | No switch rendered | same | `queryByRole("switch")` in that row is null |
| 3 | Condition text, not "always on" | same | condition string present in the row |
| 4 | Route serves 16 descriptors | GET `/api/codex-prompt` | length 16, entry present |
| 5 | Not writable | attempt a toggle write for this id | route refuses; id absent from `TOGGLE_IDS` |
| 6 | Probe honest | GET `/api/codex-prompt/text` | reason is not-exposed, never a fabricated body |
| 7 | Locale parity holds | after the i18n edit | 0 missing used keys, all locales |

Criterion 5 is the one with a real activation scenario rather than a render check: the
write path must REFUSE, and refusal is only observable by attempting it.

## Verifier commands (run before this document was accepted)

```
cd gui && bun x tsc -b --force                        # exists; reads gui/src -> yes
bun x tsc --noEmit                                    # exists; reads src/ -> yes
bun test tests/codex-prompt-layers.test.ts            # exists; reads prompt-layers.ts -> yes
bun test tests/codex-prompt-route.test.ts             # exists; reads the route -> yes
bun test ./gui/tests/codex-set-prompt-layers.test.tsx # exists; reads the panel -> yes
bun run lint:gui                                      # exists; baseline 17, bar is no-new
```

Each observes this unit's change target. `bun run privacy:scan` does not meaningfully
observe it (no logging is added) — recorded rather than claimed as a gate.

## Bypass record (PLAN-BYPASS-NAMED-01)

This work-phase adds no enforcement. The nearest thing is the `LayerId` union forcing
exhaustive copy maps: tier E1 (compiler), executing surface `tsc`, known bypass
`as never` or a non-null assertion at the call site, residual risk a blank row, wording
not downgraded. Final enforcement layer: the compiler, genuinely — a missing map entry
cannot build.
