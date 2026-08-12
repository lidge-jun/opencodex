# 004 — opencodex surfaces this unit builds on

Researcher: Raman (read-only). opencodex `dev` @ `f9b9440c5`.

## A. Route and page shell

`Page` now lives in `app-routing.ts`, not `App.tsx` (`App.tsx:23`). The id
`codex-auth` appears in:

| Place | Location |
|---|---|
| `Page` union | `app-routing.ts:5-15` |
| `VALID_PAGES` | `app-routing.ts:20-30` |
| `PAGE_TKEY` | `App.tsx:31-41` |
| `NAV` | `App.tsx:50-52` |
| render branch | `App.tsx:307-316` |
| Providers deep link | `providers-page-utils.ts:14-19` |

Routing is hash-based; the first segment resolves the page
(`app-routing.ts:36-44`). Navigation pushes history, normalization replaces
(`use-app-route-state.ts:39-90`). There is **no persisted last-page state**
(`use-app-route-state.ts:44`), so a rename needs no storage migration. Legacy
redirects already exist at `app-routing.ts:85-93` — that is where
`codex-auth` → `codex-set` goes.

`CodexAuth.tsx` (178 lines) is a thin wrapper: it owns the `/api/config` fetch,
the session cache `ocx.codex-auth.config.v1:${apiBase}`, a 30s poll, the
provider-recovery action, and the account-mode banner; then it delegates
everything else to `CodexAccountPool` (`CodexAuth.tsx:93-177`).

## B. The tab pattern — an important correction

**Logs does not use `SectionTabs`.** It reuses the `.page-tabs`/`.page-tab`
classes but swaps exclusive tabpanels and persists the choice in the hash
(`Logs.tsx:408-425`, `:522`, `:567`), lazy-mounting Debug on first visit and
keeping it mounted after (`Logs.tsx:411-423`, `:551`).

`SectionTabs` is the *other* thing: a sticky scroll-spy strip over a normally
scrolling page, used by Usage (`Usage.tsx:716`), Subagents
(`SubagentsWorkspace.tsx:73`), and API Keys (`ApiKeysWorkspace.tsx:206`). Props
are `{scope, items:[{id,label,meta?}], ariaLabel}`; anchors are
`${scope}-section-${id}` (`section-anchors.ts:11`); scroll lock is 1,200 ms
(`section-anchors.ts:23`).

`000` §Layout decision picks the Logs pattern. This document exists partly to
record that the ask's phrase "상단 로그 디버그 탭처럼" pointed at Logs, and Logs
is the tabpanel pattern — reaching for `SectionTabs` because it has "section"
in the name would have been the wrong build.

## C. Tests that a rename breaks

- `gui/tests/sidebar-codex-auth.test.ts:14-23` — presence and routing source.
- `gui/tests/dashboard-tabs.test.ts:45-52` — expects `codex-auth` **second** in
  sidebar order.

Routing tests do not enumerate `codex-auth` today
(`providers-hash-history.test.tsx:54-85`), so WP3 adds explicit old→new
deep-link coverage. `page-loading-contract.test.tsx:25-39` does not list
`CodexAuth` in `MIGRATED`; the new Prompt surface should join it.

The ~12 files touching `/api/codex-auth/**` test the **backend namespace**,
which does not move. A page rename must not touch them.

## D. i18n

`nav.codexAuth` plus **130 `codexAuth.*` keys** per locale, six locales.
Nav key: `en.ts:1108`, `ko.ts:691`, `ja.ts:1058`, `zh.ts:684`, `ru.ts:1100`,
`de.ts:666`.

English is authoritative: `TKey = keyof typeof en` (`en.ts:1662-1664`), and
every other locale is `Record<TKey, string>` (`zh.ts:1-3`, `shared.ts:9-12`).
**Key parity is compile-time enforced** — a missing translation fails
`typecheck`, so all six locales move together in one commit.

Decision: keep the 130 `codexAuth.*` keys untouched (the pool UI consumes them
directly), add a new `codexSet.*` namespace for the shell and Prompt section.

## E. Config write precedent

`src/codex/features.ts` is the model, but its header explicitly forbids
broadening it beyond `multi_agent_v2` (`features.ts:1-15`). WP1 therefore
writes a **new module**, copying the technique:

- `activeCodexConfigPath()` resolves `CODEX_HOME` at call time, expands `~`,
  canonicalizes via `realpathSync.native` (`features.ts:58-67`).
- `dominantEol`/`applyEol` preserve CRLF vs LF (`features.ts:36-48`).
- `setMaxConcurrentThreads` shows the scoped line edit: validate, refuse
  unreadable files, match only within the owning table body, stay idempotent,
  write atomically (`features.ts:248-310`).

`OCX_SECTION_MARKER` is `# Auto-injected by opencodex`, defined in
`injected-marker.ts:1-10`. Ownership is adjacency-based: a key is ours only if
the marker precedes it (`injected-marker.ts:53-60`); unmarked user keys are
preserved and block injection (`inject.ts:141-167`).

## F. Management API

Handlers take `ManagementContext` and return `Response | null`
(`context.ts:24-30`). Registration is manual: import in `management-api.ts` and
add to the null-coalescing chain (`management-api.ts:59-69`, `:127-138`).

All `/api/**` passes `requireManagementAuth` (`server/index.ts:448-453`).
Unsafe methods need browser `Origin` plus a matching CSRF token
(`management-auth.ts:246-266`); bodies cap at 2 MiB
(`management-api.ts:84-95`). `jsonResponse` lives at `auth-cors.ts:170-175`.

Shape to copy: `sidebar-routes.ts:23-89` for the module skeleton,
`agent-settings-routes.ts:127-178` for GET/PUT config-toggle semantics.

## G. GUI data contract

`useKeyedClientResource(key, deps, loader, options)` distinguishes `loading`
(replace content) from `refreshing` (keep stale content visible)
(`client-resource.ts:3-17`, `:51-55`). After a mutation, publish the confirmed
server DTO with `setClientResourceData` (`client-resource.ts:464-482`).
`useDataSurface` wraps it and classifies cold/stale/empty/failure states
(`data-surface.ts:12-48`, `:137-152`).

## H. Test harnesses

Route tests call `handleManagementAPI` directly with a concrete `URL` and a
`Request` carrying `Host` — origin derivation rejects a missing Host. See
`management-client-config-route.test.ts:46-88` (fixtures + injected seams,
plus hostile-origin rejection at `:240-243`) and `sidebar-routes.test.ts:18-58`
(helper + `finally` restore).

**Route tests must never resolve the real `CODEX_HOME`.** Writer tests take an
explicit temp `configPath`; route tests inject a writer seam.

GUI tests use Bun + happy-dom + React `act`. `client-config-panel.test.tsx` is
the dialog reference: global install/restore (`:55-69`), lazy
`react-dom/client` under `LanguageProvider` (`:86-113`), stubbed fetch
(`:132-152`), and native dialog assertions including `aria-labelledby`,
Escape, and focus return (`:204-222`).

## Reuse map

| New work | Model on |
|---|---|
| Codex Set shell, exclusive tabpanels | `Logs.tsx:408` |
| Multi-auth section content | `CodexAuth.tsx:93` (kept whole) |
| Prompt layer/custom rows + dialogs | `ClientConfigRow.tsx`, `ClientConfigDialog.tsx` |
| Prompt GET + loading | `data-surface.ts:137` |
| Post-write cache publish | `client-resource.ts:464` |
| TOML reader/writer | `features.ts:58`, `:248` — in a NEW module |
| Route module skeleton | `sidebar-routes.ts:47` |
| GET/PUT toggle semantics | `agent-settings-routes.ts:159` |
| Route registration | `management-api.ts:59`, `:127` |
| Route tests | `sidebar-routes.test.ts:18` |
| Dialog tests | `client-config-panel.test.tsx:86` |
| Deep-link regression | `providers-hash-history.test.tsx:54` |
