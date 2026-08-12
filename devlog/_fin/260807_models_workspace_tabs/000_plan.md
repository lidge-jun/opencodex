# 260807 — Models workspace tabs (Models / Combos / Routing)

## Objective

Fold three sidebar destinations into one tabbed page. The Models page becomes a
three-tab workspace — **Models** (catalog), **Combos**, **Routing (beta)** — and the
sidebar drops from eleven rows to nine.

The three tabs are not three unrelated screens sharing a container. They are the same
question asked at three depths, and the answer to all three is a model id the client
can call:

| Tab | Question | What the client sees |
|-----|----------|----------------------|
| Models | what is visible | `anthropic/claude-opus-5` |
| Combos | who answers, in the order I chose | `combo/<id>` |
| Routing | who answers, chosen by score | `policy/<id>` |

A combo and a routing profile are both virtual models that resolve to a real one; one
is manual (ordered failover / round-robin), the other automatic (hard requirements plus
a score). Grouping them under Models makes the page title honest rather than merely
shorter.

## Why the sidebar loses two rows

`Routing (beta)` moves into the strip. `Claude` goes away because it was never a page:
it is a shortcut into a tab of Integrations, and paying for it is `isNavEntryActive()`
in `gui/src/App.tsx` — a function whose entire job is stopping the sidebar from
claiming the user is in two places at once. Remove the duplicate row and the
correction disappears with it.

Combos is a special case worth stating plainly: **it is already not in the sidebar.**
The NAV array has no `combos` entry, and the only route to `#combos` today is a
`Set up` link on a card inside the Models page. So for Combos this change is not one
level deeper — it is one level shallower. A card link that swaps the whole page becomes
a sibling tab.

## Constraints

- Hash is the source of truth. Refresh, bookmark, and Back/Forward keep the tab.
  Precedent: `#logs` / `#logs/debug` in `gui/src/pages/Logs.tsx`.
- A hidden panel must not do work. The poll is in **Models itself** — `pollMs: 10_000`
  on the catalog resource plus a second 10-second V2 interval. Routing and Combos do not
  poll; they fetch once on mount. Gating covers all three, and cancellation matters as
  much as suppression: a load already in flight must be aborted, not merely ignored.
- Combos holds unsaved editor drafts. Panels mount lazily and then stay mounted so a
  half-typed combo survives a tab hop. Gate the network, never the tree.
- No `src/` runtime change. This is a GUI navigation refactor; the proxy, the routing
  engine, and every management API contract stay exactly as they are.

## External evidence

Three findings changed or confirmed decisions here. All were verified by opening the
source, not from search snippets.

**Primer, [UnderlineNav guidelines](https://primer.style/product/components/underline-nav/guidelines/)
and [navigation patterns](https://primer.style/product/ui-patterns/navigation/)** — do not
stack multiple underline tab rows directly on top of each other; and a tab that changes
the URL is `UnderlineNav`, while a tab that only swaps visible content without touching
the URL is `UnderlinePanels`. This is the direct warrant for two decisions: every page
tab here gets its own hash, and the Combos detail panel's inner `Config` / `About`
underline row must stop being an underline row (phase 3).

**Carbon, [tabs usage](https://carbondesignsystem.com/components/tabs/usage/)** — at most
six tabs, and tab variants "should never be nested within each other." Three is
comfortable. Integrations already runs eleven and reads as a second navigation bar
rather than one page's facets; that is the shape being avoided, not copied.

**W3C, [WAI-ARIA `tab` role](https://www.w3.org/TR/wai-aria/#tab) and the
[APG tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)** — `tab` elements MUST
be contained in a `tablist`; roving tabindex puts `0` on the active tab and `-1` on the
rest; Left/Right wrap, Home/End jump; an inactive panel SHOULD be hidden, and the APG
examples use the native `hidden` attribute, which is what the existing Logs code already
does.

Worth recording honestly: **the accessibility specs do not forbid nested tabs.** No
opened W3C/APG page prohibits a `tablist` inside a `tabpanel`, provided the inner set is
an independently labelled composite with its own roving-tabindex scope. So demoting the
Combos inner tabs is a *visual* decision backed by Primer and Carbon, not an
accessibility fix. The plan should not claim otherwise.

One lane produced weaker evidence and is recorded as such. A survey of comparable
products (Portkey, OpenRouter, Cloudflare AI Gateway, Kong, Vercel AI Gateway) found
that most keep the model catalog documented separately from routing/fallback config;
only Vercel nests fallbacks under models-and-providers, and that page could not be
opened (`candidate — unverified`). This is documentation structure, not UI navigation,
so it is not treated as evidence for or against this design.

## Work-phase map

Dependency-ordered. Each phase is one full PABCD cycle and one commit series.

| Phase | Doc | Deliverable | Depends on |
|-------|-----|-------------|------------|
| wp01 | `010_routing_layer.md` | Additive hash contract + `models-tab.ts`, tests | — |
| wp02a | `020_models_shell.md` | Nested workspace **alongside** the legacy pages: tab i18n, strip, panels, per-panel boundaries, active-aware CSS, catalog gating | wp01 |
| wp02b | `020_models_shell.md` | Route cutover: union removal, redirects, three links, Routing NAV row + `IconRoute` | wp02a |
| wp03 | `030_combos_embed.md` | Combos panel: `retainedData` state path, abort signal, inner tabs demoted, count callback | wp02b |
| wp04 | `040_routing_embed_and_sidebar.md` | Routing panel: shared abort controller, heading removal + its test, Claude row, subtitles, render grounding | wp02b |

wp03 and wp04 both depend on wp02b but not on each other; they run in order because they
touch the same panel block.

**Why wp02 is two halves.** The first draft spread this work across three phases and
produced commits that could not compile (audit round 1). The correction over-swung: one
atomic phase that was atomic in the sense of *unreviewable* (audit round 2). The split
the second audit proposed is better than either: wp02a builds the nested workspace while
`#combos` and `#routing` keep working, so both routes render and every existing Routing
test stays valid; wp02b then deletes the old form only once the new one is proven in the
same tree.

## Out of scope

`src/` runtime, `src/routing/` engine behaviour, management API contracts, docs-site,
release, and promotion to `main`/`preview`. No push and no PR without explicit
approval.

## Verification

Every phase ends green on **five** commands:

```bash
bun run typecheck
bun run test              # root tests/ ONLY
cd gui && bun test tests  # the 116-file GUI suite — a SEPARATE run
bun run lint:gui
bun run build:gui
```

`bun run test` does **not** reach `gui/tests/`: `scripts/test.ts:122` defaults to
`["./tests/"]`. The first draft missed that directory entirely and concluded no test
covered the affected routes; the second draft knew it existed and still asserted the root
command ran it. Both were wrong, and the second kind of wrong is worse — an assumption
stated as fact inside the document that defines what "green" means.

`gui/tests/` holds the mounted happy-dom tests for page loading, the sidebar, and the
Routing page. Those are the oracle. `expect(src).toContain(...)` checks are supplements
that pass while the UI is broken.

The final phase additionally requires live browser observation
(C-RENDER-GROUNDING-01): drive all three tabs, refresh on each, Back/Forward, and
arrow-key traversal against the running dashboard, read the screenshots back, and fix
what observation reveals. Static gates passing is not the same as the thing working.
