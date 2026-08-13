# Phase 2 — Models shell

The atomic phase: the `Page` union loses `combos` and `routing`, the tab strip appears,
and the panels that replace those pages mount. Splitting any of it out would leave a
commit where a page has been deleted but its replacement does not exist.

**Scope grew after audit round 1** (`001_audit_round1.md`). Four things that were
deferred to later phases cannot be: the Routing NAV row (typed `Page`, so the union
removal breaks it), the tab-shell i18n keys (`TKey` derives from `en`), the full-bleed
CSS (phase 2 inserts the wrapper that breaks the selector), and the catalog poll gating.
Deferring them meant shipping a commit that does not compile or knowingly renders a
broken layout. This is the big phase, and that is correct.

## MODIFY `gui/src/app-routing.ts` — remove the two pages

```diff
 export type Page =
   ...
   | "models"
-  | "combos"
   | "subagents"
   ...
-  | "integrations"
-  | "routing";
+  | "integrations";
```

Same two entries out of `VALID_PAGES`. Then the legacy ids in `readPageFromHash`,
beside the existing `debug` line:

```ts
// Legacy: Combos and Routing used to be standalone pages; both are Models tabs now.
if (pageId === ("combos" as Page) || pageId === ("routing" as Page)) return "models";
```

and the redirects in `resolveAppHashChange`, directly after the `debug` branch:

```ts
if (rawHash === "combos" || rawHash.startsWith("combos/")) {
  return { page: "models", replaceTo: "models/combos" };
}
if (rawHash === "routing" || rawHash.startsWith("routing/")) {
  return { page: "models", replaceTo: "models/routing" };
}
```

The `startsWith` arm is not decoration: `#routing/foo` from an old bookmark must reach
the Routing tab rather than be normalized to a bare page that drops the destination —
the exact failure the file's `#api` comment already documents.

## MODIFY `gui/src/App.tsx`

`PAGE_TKEY` loses its `combos` and `routing` keys (the compiler demands it — the record
is keyed by `Page`).

Render block:

```diff
-  {page === "models" && <Models apiBase={API_BASE} />}
-  {page === "combos" && <Combos key={API_BASE} apiBase={API_BASE} />}
+  {page === "models" && <Models key={API_BASE} apiBase={API_BASE} />}
   ...
-  {page === "routing" && <RoutingProfiles key={API_BASE} apiBase={API_BASE} />}
```

`Combos` and `RoutingProfiles` imports move out of `App.tsx` into `Models.tsx`.

The full-bleed modifier stops asking about the page and starts asking about the tab:

```diff
-<div className={`main-inner${page === "combos" ? " main-inner--combos" : ""}`}>
+<div className={`main-inner${modelsTab === "combos" && page === "models" ? " main-inner--combos" : ""}`}>
```

where `modelsTab` comes from a `readModelsTab()` state synced on `hashchange` /
`popstate`, the same listener pair `useAppRouteState` already installs.

> This is the one piece of tab knowledge that has to live in App rather than in
> Models: the `.main-inner` element is App's, and phase 3 explains why the modifier
> cannot simply move inside the page.

### NAV: the Routing row goes now

```diff
-  { id: "routing", tkey: "nav.routing", Icon: IconRoute },
```

plus the `IconRoute` import if unused elsewhere. Not optional and not deferrable:
`NavEntry.id` is typed `Page` (`App.tsx:53`), so a NAV entry naming a removed page is a
type error the moment the union shrinks.

The duplicate **Claude** row and `isNavEntryActive` stay until phase 4 — they are a
separate concern (Integrations, not Models) and they still typecheck.

### Per-panel error boundaries

`ErrorBoundary` is keyed on `page` (`App.tsx:328`). With three tabs on one page, an
error thrown in Combos survives a switch to Routing, because the key never changes.
Adding the tab to the key is worse: every ordinary switch remounts the workspace and
destroys drafts.

So each tabpanel gets its own boundary inside `Models.tsx`, and App's page-level
boundary stays as the outer net. A failing panel then shows its error in its own panel
and the other two keep working.

### Full-bleed CSS moves here

The wrapper this phase introduces is what breaks
`.main-inner--combos > .combos-workspace-shell`, so the repair ships in the same
commit. Full detail in `030`; the rules land here.

Including the one the first draft missed: `.main-inner:has(.models-workspace-shell)`
(`styles-models-workspace.css:8`) widens the column to 1200px, and a lazily-mounted
hidden catalog still matches it. Left alone, Routing renders at 980px on a direct visit
and 1200px once the catalog has been opened — width that depends on history. The
selector must match only a **visible** catalog panel.

### Catalog work stops when the catalog is hidden

`Models` polls: `pollMs: 10_000` on the catalog resource (`Models.tsx:271`) and a
separate 10-second `setInterval` for V2 (`Models.tsx:302`). Both keep running while the
user is on Combos or Routing unless gated on `tab === "catalog"` — the leak the plan
claimed to prevent while overlooking the only panel that actually had one.

## MODIFY `gui/src/pages/Models.tsx`

### Tab state

```tsx
const [tab, setTab] = useState<ModelsTab>(readModelsTab);
const [mounted, setMounted] = useState<ReadonlySet<ModelsTab>>(() => new Set([readModelsTab()]));

const activateTab = (next: ModelsTab) => {
  setTab(next);
  setMounted(current => (current.has(next) ? current : new Set([...current, next])));
};
```

Copied deliberately from `Integrations.tsx`: panels mount lazily and then stay mounted
so a half-typed combo draft survives a tab hop, and the accumulation happens in the
event handler rather than an effect so a switch costs one render, not two.

`hashchange` + `popstate` listeners call `activateTab(readModelsTab())`.

### Strip markup

`.page-tabs` / `.page-tab` / `.page-tab--active`, `role="tablist"`, roving tabindex,
`aria-selected`, `aria-controls`, and Arrow/Home/End — the wiring the APG requires and
that `Integrations.tsx` already implements. Each label carries a `.section-tab-meta`
count: `Models 35/273`, `Combos 3`, `Routing 2`. The class and its
`page-tab--active > .section-tab-meta` rule already exist in `styles.css`.

Counts come from data the page already holds — `effectiveVisibleCount` / `models.length`
for the catalog and `combos.length` from the existing `combosResource`. Routing's count
needs a profile list, which the Routing panel owns; until it reports one the meta is
omitted rather than rendered as `0`, because a wrong count is worse than none.

### Body split

Everything currently returned by the component — rail, controls, provider list, modals
— becomes the catalog panel body. The three panels are siblings, each `hidden` when
inactive (`hidden` per the APG examples, matching the existing Logs code).

The page header (`h2` + count) and the strip live above all three panels and stay
visible on every tab. The `page-sub` is ONE element rendered between the strip and the
panels, carrying the active tab's copy — see the subtitle note above.

## wp02a tests — new, in `gui/tests/` (mounted, happy-dom)

The oracle. Source-string checks are supplements that pass while the UI is broken.

- Cold load at `#models/combos` renders the Combos panel; `#models/routing` renders
  Routing.
- Clicking each tab updates both the rendered panel and the hash.
- Arrow Left/Right/Home/End move focus and selection together.
- A panel that throws shows its error while the other two still render.
- With Combos visible, no `/api/models`, `/api/v2`, `/api/provider-context-caps`, or
  `/api/providers` request fires after the poll interval elapses.
- A cold load at `#models/combos` renders no `0/0` count.

Nothing existing changes in this half — `#combos` and `#routing` still work, so
`page-loading-contract` and `routing-profiles` stay green untouched. That is precisely
what splitting here buys.

---

# wp02b — route cutover

The old form dies in one commit, with the new form already proven beside it.

## MODIFY `gui/src/app-routing.ts`

Remove `"combos"` and `"routing"` from the `Page` union and `VALID_PAGES`. Then the
legacy ids in `readPageFromHash`, beside the existing `debug` line:

```ts
// Legacy: Combos and Routing used to be standalone pages; both are Models tabs now.
if (pageId === ("combos" as Page) || pageId === ("routing" as Page)) return "models";
```

and the redirects in `resolveAppHashChange`, directly after the `debug` branch:

```ts
if (rawHash === "combos" || rawHash.startsWith("combos/")) {
  return { page: "models", replaceTo: "models/combos" };
}
if (rawHash === "routing" || rawHash.startsWith("routing/")) {
  return { page: "models", replaceTo: "models/routing" };
}
```

The `startsWith` arm is not decoration: `#routing/foo` from an old bookmark must reach
the Routing tab rather than be normalized to a bare page that drops the destination —
the exact failure the file's `#api` comment documents.

## MODIFY `gui/src/App.tsx`

- `PAGE_TKEY` loses both keys (the record is keyed by `Page`; the compiler demands it).
- Delete the `page === "combos"` / `page === "routing"` render branches and their imports.
- Delete the Routing NAV row, and `IconRoute` if now unused. `NavEntry.id` is typed
  `Page` (`App.tsx:53`), so the union change forces this rather than it being a choice.
- Simplify the modifier to `page === "models" && modelsTab === "combos"`.

The duplicate **Claude** row and `isNavEntryActive` stay until wp04 — separate concern,
still typechecks.

## MODIFY `gui/src/pages/Models.tsx`

The three `href="#combos"` links (`:1104`, `:1132`, `:1143`) point at `#models/combos`.
Missing these was audit round 1's B2: the redirect fires, rewrites the URL, and leaves
the tab on the catalog because `replaceHash` emits no `hashchange`.

## wp02b tests

`tests/models-workspace-tabs.test.ts`: `VALID_PAGES` holds neither id;
`resolveAppHashChange` maps `combos`, `combos/x`, `routing`, `routing/x`.

`gui/tests/page-loading-contract.test.tsx`: boots at `#combos` (`:136`) and asserts
`.combos-workspace-shell-body` (`:183`). The URL becomes `#models/combos`; the shell
assertions stay valid because the workspace markup does not change.

**`gui/tests/routing-profiles.test.tsx` is NOT touched here.** It asserts
`[data-page="routing"]` and the literal "Routing Intelligence (beta)" (`:175`), and the
heading it depends on is removed in wp04. Editing it now means either a red wp02b or
coverage deleted two phases before the behaviour changes.

## MODIFY `tests/routing-intelligence-ui.test.ts`

Now genuinely stale, and the compiler cannot catch a string assertion:

```diff
-  expect(VALID_PAGES.has("routing")).toBe(true);
-  expect(readPageFromHash("routing")).toBe("routing");
-  expect(hashBelongsToPage("routing", "routing")).toBe(true);
-  expect(resolveAppHashChange("routing").replaceTo).toBeNull();
+  expect(readPageFromHash("models/routing")).toBe("models");
+  expect(hashBelongsToPage("models/routing", "models")).toBe(true);
+  expect(resolveAppHashChange("models/routing").replaceTo).toBeNull();
+  expect(resolveAppHashChange("routing")).toEqual({ page: "models", replaceTo: "models/routing" });
```

and `expect(app).toContain('page === "routing"')` becomes an assertion that
`Models.tsx` mounts `RoutingProfiles`.

## Verification (both halves)

All five commands green, including the separate `cd gui && bun test tests` — the root
`bun run test` does not reach the GUI suite (`scripts/test.ts:122`).

Browser observation starts here rather than waiting for wp04, because this is where a
mistake shows up as a blank page or a collapsed workspace: load `#models`,
`#models/combos`, `#models/routing`, confirm each paints, and confirm the Combos
workspace fills the viewport under the header and strip.
