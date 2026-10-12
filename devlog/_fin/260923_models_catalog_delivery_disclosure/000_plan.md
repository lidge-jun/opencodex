# Models page: collapsible "How changes reach Codex" disclosure

The Models tab shows a static three-row card ("Saved on hub / Fetched by this client /
Active in a running client") between the subtitle and the workspace. Two rows are fixed
sentences, the middle row reads "not reported" on every standalone install because
`catalogSyncedAt` only exists in `ocx connect` client mode, and the subtitle repeats the
same caveat. The card pushes the workspace down and does not explain the process. This unit
replaces it with a one-line `<details>` disclosure that names the real delivery steps for
the current mode and expands into a detailed explanation, trims the duplicated subtitle
sentences, and fixes the save toast that says "hub" on standalone installs.

## Loop spec

- Loop archetype: satisfy-spec, single work-phase (wp1), C2 GUI change.
- Trigger: user request 2026-09-23 ("반영 과정 이렇게 해놓고 한줄로 접기, 설명은 더 자세하게", cxc-loop, mimo subagents).
- Goal: collapsed one-line summary of the delivery steps; expanded detail per step with what it means, how OpenCodex knows, and what to do.
- Non-goals: no `src/` runtime change, no change to CodexStaleBanner/appServerState logic, no docs-site edit, no push/PR/merge/service restart.
- Verifier: `bun x tsc --noEmit -p tsconfig.app.json` in gui/ (reads every locale file and the component via tsconfig.app include of src); `bun test tests/models-status-toast.test.tsx tests/codex-stale-banner.test.ts tests/i18n-locales.test.ts tests/i18n-language-switch.test.tsx` in gui/ (key-set and placeholder parity read all ten catalogs; the toast test mounts Models); render grounding on Vite dev server proxied to :10100 (collapsed + expanded screenshots, ko). Client-mode branch has no live hub here: it is exercised by a focused render assertion in gui/tests (see activation below).
- Stop condition: all six goalplan criteria met with fresh evidence and a local commit.
- Memory artifact: this directory; goalplan `.codexclaw/goalplans/opencodex-gui-models-page-worktree-users-jun-cod/`.
- Expected terminal outcomes: DONE; BLOCKED if the GUI cannot render or typecheck cannot run; NEEDS_HUMAN if copy would contradict the #5031 honesty contract.
- Escalation: two distinct translator agents failing the same locale -> main translates it directly.
- Resource bounds: no user token/time budget; mimo subagents (aim/mimo-v2.6-flash-free), write scope one locale file each.

## Facts the design rests on

- `catalogSyncedAt` origin: gui/src/App.tsx:506 -> gui/src/api-targets.ts:172 (only when connected) -> src/client/connect.ts:601/684 (hub catalog download written to DEFAULT_CATALOG_PATH).
- Standalone: `targets.connected === false`; Models edits this proxy's catalog directly.
- Codex reads the catalog when its app-server starts; the page-head button (`dash.codexRestart` "Codex 모델 목록 새로고침") stops app-servers and the user reopens Codex (ko.ts:342-346).
- CodexStaleBanner appears above the tabs when the running app-server is older than the catalog.

## File change map

| File | Change |
|---|---|
| gui/src/pages/models-catalog-state.tsx | Replace `ModelCatalogStateSummary` with `ModelCatalogDelivery({ connected, catalogSyncedAt })`: `<details className="models-delivery">` closed by default, `<summary>` = title + step chips joined by arrows, body = `<ol>` of 2 (standalone) or 3 (client) steps + hint. |
| gui/src/pages/Models.tsx | Props gain `connected?: boolean` (same line); call site renders `<p className="page-sub">` then `{tab === "catalog" && <ModelCatalogDelivery .../>}`. Net line delta <= +2 (cap 2792, now 2784). |
| gui/src/App.tsx | Pass `connected={targets.connected}` on the existing Models line (0 lines). |
| gui/src/styles-models-workspace.css | `.models-delivery*` rules (styles.css is at cap and unchanged). |
| gui/src/i18n/{en,ko,de,fr,ja,ru,tr,vi,zh,zh-TW}.ts | Remove `models.catalogState.*` (8 keys); add `models.delivery.*` (listed below); rewrite `models.subtitle` (drop last two sentences) and `models.applied` (mode-neutral). |
| gui/tests/models-catalog-delivery.test.tsx (new) | Render assertions for standalone (2 steps, no sync step) and client (3 steps, time and unknown variants), closed by default. gui/tests has no layout registry; tsconfig.app.json does not compile tests, so running the test is its verifier. |

## i18n keys (en source)

- models.delivery.title: "How changes reach Codex"
- models.delivery.chip.saved: "Saved"; chip.savedHub: "Saved on hub"; chip.synced: "Synced {time}"; chip.syncedUnknown: "Sync not recorded"; chip.loaded: "Loaded when Codex restarts"
- models.delivery.saved.title / .body (standalone save)
- models.delivery.savedHub.title / .body (client-mode save)
- models.delivery.synced.title / .bodyAt ({time}) / .bodyUnknown
- models.delivery.loaded.title / .body
- models.delivery.hint

## Conditional paths and activation

- `connected` true vs false: activation = new test renders both; standalone also observed live.
- `catalogSyncedAt` valid / missing / unparsable: test renders valid and missing; unparsable goes through the same `formatFetchTime` null path.
- Tab gate: disclosure only on catalog tab; observed live by switching to Combos.

## Architect consultation

See 010_architect.md.
