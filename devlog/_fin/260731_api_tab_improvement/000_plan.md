# 000 — API tab improvement

Unit: `devlog/_plan/260731_api_tab_improvement/`
Opened: 2026-07-31 · Work class: C4 · Branch target: `dev`
Base commit at open: `33caf3364` (`dev`, fast-forwarded from `origin/dev`)

## Objective

Make the GUI API tab tell the truth about the proxy's public surface, and give a
`ocx_` key an identity beyond "a row that can be deleted".

Today the tab answers one question — *what is my base URL and which models can I
call* — and answers a second one wrongly. It documents an authentication rule the
server does not implement, it advertises three protocols but tests one, and every
key it lists shows the same eight characters because every generated key starts
with the same nine.

## The three defects that set the scope

These are not a wish list. Each one is a statement the tab makes that the code
contradicts.

**1. The tab documents a header the server rejects.** `api.authChatCompletions`
says Chat Completions accepts `Authorization: Bearer ocx_...`
(`gui/src/i18n/en.ts:1266`). The route calls `requireResponsesApiAuth`
(`src/server/index.ts:654`), which reads only `x-opencodex-api-key`
(`src/server/auth-cors.ts:265-274`). A remote user following the on-screen
instruction gets a 401 and no way to find out why. `/v1/models` and `/v1/messages`
*do* take bearer (`src/server/index.ts:403`, `src/server/index.ts:617`), so the
rule is per-endpoint and the single sentence cannot express it.

**2. Every key looks identical.** POST builds `ocx_data_` + 40 hex
(`src/server/management/oauth-account-routes.ts:457`) and GET masks
`key.slice(0, 8)` (`.ts:444`), so the prefix column reads `ocx_data...` for every
row (`ApiKeysWorkspace.tsx:150`). The one field meant to identify which secret is
deployed where identifies nothing.

**3. The key detail pane repeats the rail.** The rail row shows name, prefix and
date (`ApiKeysWorkspace.tsx:142-153`); selecting it shows name, prefix and date
(`ApiKeysWorkspace.tsx:204-219`). This is the exact duplication that got the
Subagents rail deleted a week ago (`5aa51b9d7`: "the per-model detail pane carried
no information the row did not already show"). The API tab kept its rail through
that sweep and still has nothing to put in it.

Defect 3 is the reason this unit adds per-key attribution rather than only fixing
copy: a detail pane earns its place when it holds something the row cannot.

## Constraints

| Constraint | Source |
|-----------|--------|
| Never render or log key material beyond the one-time POST response | AGENTS.md privacy boundary; `privacy:scan` |
| Admission behavior must not change while attribution is added | `001` §1 — auth is a security boundary |
| No new dependency; Bun-native TypeScript | AGENTS.md runtime constraints |
| Every new visible string lands in all six locales | `gui/AGENTS.md` §Text and i18n |
| Capped regions hand the wheel back (`overscroll-behavior: auto`) | `87681e540`, `5aa51b9d7` |
| `usage.jsonl` rows written by older builds must keep parsing | `src/usage/log.ts:266-337` |
| Security findings never enter a tracked path | AGENTS.md §Security working notes |

## Scope boundary

IN

- Per-endpoint auth truth: server-derived header matrix replacing the four prose
  lines, and the endpoint rows that carry it.
- Key identity: a distinguishing suffix for new keys, and per-key request
  attribution end to end (admission → request log → usage → management → GUI).
- Key lifecycle: rename, and a DELETE that reports whether it deleted anything.
- The detail pane rebuilt around what attribution provides.
- Layout: remove the desktop `100dvh` shell and the `overscroll-behavior: contain`
  scrollers, matching what Usage/Storage/Subagents already did.
- Tests at every phase, including the first direct `/api/keys` route tests.

OUT

- Expiry, scopes/allowlists, and rotation. Each changes what a key is *allowed to
  do*, which is an authorization-semantics decision, not a dashboard improvement.
  `001` §3 records the design; this unit does not build it.
- Reverse-proxy / forwarded-header endpoint derivation. Real defect, wrong unit —
  it is a trust-boundary change and `fix/760-management-origin-tls` is already
  open upstream. `001` §5 records it and phase 2 must not conflict with it.
- Retroactive attribution. Rows already in `usage.jsonl` have no key id and will
  not gain one; the GUI states this rather than showing a misleading zero.
- Changes to routing, adapters, the catalog, or the provider registry.
- The client-config export panel — that is `260731_client_config_export` phase 4.
  See §Coordination.

## Work-phase map

Dependency-ordered (PHASE-SPLIT-01). Each phase consumes the verified output of
the one before it and closes with something independently verifiable.

| Phase | Doc | Delivers | Verified by |
|-------|-----|----------|-------------|
| 1 | `010_key_identity_and_crud.md` | Distinguishable key suffix; `PATCH /api/keys` rename; DELETE reports 404 on unknown id; explicit `apiKeys` config schema | first direct `/api/keys` route tests; config round-trip |
| 2 | `020_admission_identity.md` | `resolveDataPlaneAdmissionSecret()` returning the matched key id; boolean wrappers unchanged | admission matrix test incl. loopback/env/unknown; no behavior delta |
| 3 | `030_attribution_telemetry.md` | `apiKeyId` + `admissionKind` + `inboundProtocol` through request-log → `usage.jsonl`; per-key rollup and `authMatrix` on `GET /api/keys` | end-to-end: authed request appears attributed in the rollup |
| 4 | `040_gui_detail_and_matrix.md` | Detail pane on real attribution; server-derived auth matrix; rename UI; model-test protocol fix | GUI tests + render grounding at 1280x720 |
| 5 | `050_layout_and_hardening.md` | Kill the `100dvh` shell and `contain` scrollers; uncollapse usage examples; locale parity test | wheel-handoff proof; full GUI gates |

**Where the small correctness fixes go.** W4 (clipboard), W9 (empty vs filtered),
W13 (models retry), W14 (live region), W15 (name `maxLength`) are not a phase.
They belong to the component whose markup owns them, so each lands in the phase
that is already editing that file:

| Defect | Phase | Why there |
|--------|-------|-----------|
| W14 live region on test results | 4 | Phase 4 rewrites the result badge into per-protocol chips; the announcement is part of that rewrite, not a later pass |
| W15 `maxLength` on name inputs | 4 | Phase 4 builds the rename input; the create input gets the same constant in the same edit |
| W4 clipboard failure | 4 | Same `ApiKeys.tsx` copy handlers phase 4 already touches |
| W9 empty vs filtered | 5 | Copy-only change in the models panel phase 5 is restyling |
| W13 models retry | 5 | Needs `refreshModels` plumbed through the resource, independent of phase 4's contract |

Phase 5 is then one thing — the scroll model and what depends on it — plus the
locale parity gate that must run after every string in the unit exists. That is a
dependency, not a leftovers bucket: parity can only be asserted once phase 4's
keys are in the tree.

Phase 1 is first because every later phase writes to the key entry, and an
unvalidated passthrough schema (`src/config.ts:669-704`) is the wrong foundation
to add fields to. Phase 2 is the only phase that touches the admission path, and
it changes no decision — only what the function returns. Phase 3 cannot start
before 2 because there is no id to record. Phase 4 is the first phase a user sees.
Phase 5 is polish and must come last: it moves the same markup phase 4 rewrites.

## Coordination with `260731_client_config_export`

That unit's phase 4 (`040_gui_panel.md`) mounts a new `ClientConfigPanel` into
`ApiKeysWorkspace` "in the connect cluster" — the `awi-overview-left` column that
today holds Manage, Endpoints and Usage panels
(`ApiKeysWorkspace.tsx:224-247`).

Both units therefore write `ApiKeysWorkspace.tsx` and
`styles-apikeys-workspace.css`. They **do** overlap; the reconciliation below is
what makes the overlap safe, and it binds this unit.

- **Panel order.** This unit adds, removes and reorders nothing in
  `awi-overview-left` (`ApiKeysWorkspace.tsx:224-247`). Phase 4 changes the
  **detail** pane and the **endpoints** panel's internals; phase 5 changes scroll
  geometry. The other unit appends `ClientConfigPanel` to that column. Since one
  unit only appends and the other never touches the list, the JSX conflict is a
  trivial adjacent-insert either way it lands.
- **Landing order: this unit's phase 5 should land before the export panel.**
  Phase 5 removes the desktop `100dvh` shell, after which a long JSON block needs
  no special handling. If the export panel lands first it still works, but its
  `040_gui_panel.md:63-65` wheel-scroll note becomes stale and should be dropped
  when phase 5 lands.
- **The shared code-block rules stay unscoped.** `040_gui_panel.md:63-65` says the
  export panel's JSON block inherits `.api-example-pre`'s wheel behavior. Phase 5
  therefore keeps `.api-example-pre` / `.api-example-copy-btn` as unscoped
  selectors rather than narrowing them to `.awi-usage-panel`, and asserts that in
  a source guard. Narrowing them would silently re-trap the export panel's
  scroll — the exact defect phase 5 exists to remove.
- **i18n namespaces are disjoint:** `api.clientConfig.*` is theirs;
  `api.auth.*` / `api.key.*` / `api.attribution.*` are this unit's. Phase 5's
  full-parity locale test counts every `api.*` key, so whichever unit lands
  second must have its keys in all six locales — which both units already require.

## SoT sync target (SOT-SYNC-01)

`structure/` holds the maintainer invariants. Phase 2 and 3 change a security-
adjacent contract (what admission returns) and a durable record shape
(`usage.jsonl`), so their C phase patches the structure doc that owns the server
and usage subsystems. Phase 4/5 are GUI-local and sync `docs-site/` only if the
auth matrix changes documented user instructions — it does, so the Chat
Completions bearer claim must be corrected there in the same phase it is
corrected in the GUI.

## Documents in this unit

| Doc | Contents |
|-----|----------|
| `000_plan.md` | this file |
| `001_surface_inventory.md` | current component/data map, key model, weakness list with evidence |
| `002_backend_feasibility.md` | admission path, telemetry shape, lifecycle gaps, endpoint derivation |
| `003_ux_direction.md` | what the detail pane is for, the auth matrix design, sibling-tab grammar |
| `010`–`050` | one diff-level phase document each |

## Cross-phase contracts settled at roadmap lock

Two shapes are shared across phase boundaries and are fixed here so a later P
cannot quietly reinterpret them.

**`attributionSince` is top-level and singular.** `GET /api/keys` returns
`usage` on every key row (zeroes are a real answer) plus one response-level
`attributionSince`. The field describes the usage *data set* — the earliest row
carrying a recognized `admissionKind` — not a property of a key. It is keyed on
the kind rather than on `apiKeyId` because environment and loopback rows are
attributed traffic too; they simply have no configured key to point at. The GUI branches on it to tell
"attributed nothing" from "nothing is attributable yet"; branching on `usage`
would merge those two states. Defined in `030` §Design, consumed in `040`
§Phase-P contract gate.

**Admission identity is two fields, and `usage` is a union.** `apiKeyId` holds a
configured entry's id and nothing else; `admissionKind`
(`configured|environment|loopback`) says which kind of admission ran. A single
field with `"loopback"` as a sentinel would collide with a hand-edited entry whose
id is that word, since ids are only validated as non-empty strings. And because
two entries *can* share an id, `usage` is
`{ ambiguous: true } | { requests7d; totalRequests; lastUsedAt? }` — a union, so no
consumer can print a total that belongs to two keys. Defined in `030`, rendered in
`040`.

**The authenticated model test only runs on a freshly generated key.** The GUI
holds key material exactly once, in the POST response; GET returns a prefix. The
test controls are therefore disabled outside that window, with copy explaining
why. Rationale and rejected alternatives in `003` §4.

**The rail is conditional on phase 3.** If attribution does not land, phase 4
deletes the rail rather than shipping a third repeated detail pane. That is a
build-time branch chosen at phase 4's P from the shipped contract, never a
runtime inference from rows that happen to have no usage (`003` §2, `040`
§Rail decision).
