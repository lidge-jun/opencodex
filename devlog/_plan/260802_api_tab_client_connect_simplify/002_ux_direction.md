# 002 — UX direction

Design decisions for the two asks in `000`. `010` and `020` own the markup; this
document owns what the surface means and why.

## 1. Design Read

```yaml
---
name: opencodex API Access
colors:
  # Inherited. This unit introduces no new colour; tokens come from styles.css.
  primary: "var(--accent)"
  accent: "var(--accent-soft)"
  background: "var(--surface)"
typography:
  heading: { fontFamily: inherit, fontSize: var(--text-subtitle) }
  body: { fontFamily: inherit, fontSize: var(--text-control) }
iconography:
  system: "in-repo icons.tsx set"
  weight: "regular"
  domain: "library-subset"
---
```

Reading this as: **a developer tool's connect tab for someone who already runs
the proxy and now needs to get a string out of it and into another program.**

It is closer to a serial-port settings dialog than to a dashboard: the user
arrives with a specific transport intent (copy the base URL, take the config,
grab a model id), completes it, and leaves. Nothing here is browsed for
pleasure and nothing is monitored over time.

Do's: full-width tables that do not clip; one copyable string per line; the
primary action visible without scrolling in the empty state.
Don'ts: multi-band splits; a payload rendered at rest that nobody reads; a
four-column rule delivered through a horizontal scroller.

## 2. Dial setting

```
DESIGN_VARIANCE: 3
MOTION_INTENSITY: 1
Product density profile: D6
```

Reasoning: developer/admin control surface with high information density and
repeated expert use. The preset table puts Dashboard/SaaS admin at 3/2/5 and
Finance/ops at 2/1/7; this tab sits between them and inherits an existing
design system, so variance stays at the low end. The redesign is `preserve`,
not `overhaul` — the ask is to remove structure, not to add expression.

Motion 1 means: no scroll-driven reveals, no entrance animation on the rows.
The dialog uses whatever the existing `dialog.modal-overlay` already does and
adds nothing.

## 3. Lazy-User Gate applied to the config panel

Ponytail order, against the current panel:

1. **Do nothing.** Can a correct default remove the client decision? No — a
   user runs OpenCode or Pi, and we cannot know which. The decision is real.
2. **Delete.** Can the client *switch* go? Yes. With two clients, a segmented
   control makes the user choose before acting, and choosing wrong shows the
   wrong config. Rendering both rows deletes the decision entirely: the user
   scans for their client and acts on that line. This is the whole of the
   maintainer's ask, and it is also the correct answer independently.
3. **Absorb.** The system already absorbs the hard part — model list, context
   windows, env reference, destination path all come from the server.
4. **Demote.** What remains after (2) is inspection: the config body, the
   destination path, the env hint, the merge warning, the "where this file
   goes" note. None of it is needed to *perform* the action; all of it is
   needed to *understand* it. Demote to a detail dialog.

The one primary action per row is `Copy JSON`. `Download` is secondary and
`Details` is tertiary.

### Why demotion here does not violate the no-disclosure rule

`260731_api_tab_improvement/003` §5 bans hiding load-bearing content behind a
closed disclosure, and it was written about the auth matrix and the curl
examples — content that answers "how do I call this?" for a reader who does not
know to look. The config JSON is a different object: it is cargo, not an
answer. The user's questions are "which file?" and "how do I get it?", and both
stay on the surface (the row names the client; the buttons perform the
transfer). A reader who wants to audit the bytes before pasting them opens the
dialog deliberately. `000` §Constraints records this distinction so the audit
does not have to rediscover it.

## 4. Row anatomy

```
┌──────────────────────────────────────────────────────────────┐
│ [mark]  OpenCode                      [Copy JSON] [Download] │
│         ~/.config/opencode/opencode.json · 19 models    [ⓘ]  │
├──────────────────────────────────────────────────────────────┤
│ [mark]  Pi                            [Copy JSON] [Download] │
│         ~/.pi/agent/models.json · 19 models             [ⓘ]  │
└──────────────────────────────────────────────────────────────┘
```

The maintainer's sketch was one line per client. The second line is a deliberate
addition of two facts and nothing else — where the file goes and how many models
it carries — because "Download" without a destination is the exact ambiguity the
existing announcement text works to prevent ("Downloaded X. Nothing changed yet
— merge it into Y yourself."). Both come free in the envelope. The second line
is quiet (`muted`, `--text-label`) and never wraps to a third.

### The mark

`001` §4 records that only `opencode.svg` exists and no Pi asset does. Options
considered:

| Option | Verdict |
|--------|---------|
| Emoji | Banned outright (emoji-as-UI-element, STRICT) |
| Invent a Pi logo | Out of scope; a wrong brand mark is worse than none |
| Reuse the `provider-icons.ts` alias lookup | Rejected — couples export-client ids to provider ids; `001` §4 |
| Monogram tile for both clients | **Rejected at the A gate** |
| Real asset where one exists, monogram fallback where none does | **Chosen** |

The first draft chose a monogram for both clients so the two rows would scan as
siblings. The audit rejected that and it was right: the maintainer's sketch says
"(로고)" explicitly, `gui/public/provider-icons/opencode.svg` exists, and mixed
real-asset/fallback rendering is ordinary capability degradation rather than a
rendering bug. Symmetry is not worth surrendering recognition.

Settled: **`opencode.svg` for the OpenCode row**, a monogram tile — the client's
first letter in a bordered square using existing surface/border tokens — only
for clients with no asset, which today means Pi alone. The asset mapping is a
small export-client record local to this panel, kept separate from
`provider-icons.ts` (`001` §4: the namespaces are unrelated). `010` §Row marks
carries the implementation form.

## 5. Dialog contract

Uses the repository's existing native-`<dialog>` pattern
(`codex-account-reset-modal.tsx:29-51`).

**Nothing behavioral is inherited.** The audit corrected an earlier claim here
that focus trap, Escape, and backdrop dismissal come free from the CSS classes.
`.modal-overlay` and `.modal-card` supply appearance and scrolling only; the
browser's focus trap arrives from `showModal()`, and Escape, backdrop dismissal,
and focus restoration are each explicit code in the existing component. `010`
§Dialog contract enumerates all seven behaviors this unit must write.

Contents, in order: client name as the title; the config JSON in the existing
`.api-code`/`.api-example-pre` block; destination file; env hint; model count and
the degraded line when `modelsWithoutLimits > 0`; the no-key line when the user
has no keys; the merge warning; the "where this file goes" note. `Copy JSON` and
`Download` are repeated in the dialog footer so a user who opened it to check
the bytes can act without closing it.

**The `max-height` constraint (`001` §5).** `apikeys-layout.test.ts` asserts the
stylesheet's complete `max-height` list equals `["min(574px, 58vh)"]`. The
dialog must therefore not introduce one. `.modal-card` in `styles.css` already
owns the dialog's own bounding; the JSON block inside it scrolls with the card
rather than with a cap of its own. If that proves impossible in the rendered
check, the correct fix is to amend the test with a stated reason — the invariant
it protects is "only the catalog caps a *page* region", and a dialog is not a
page region — never to delete the assertion.

## 6. Fetch policy for N rows

`001` §3 notes that N rows means N GETs. Decision: fetch every client's envelope
on mount, in parallel, each row owning its own state. Rationale:

- The row needs `destination` and `modelCount` to render its second line, so a
  lazy fetch would render two placeholder rows and then reflow.
- Each row must be independently actionable: one client's 503 must not disable
  the other's buttons. Per-row state is what makes that true.
- Two requests to a loopback management API on tab open is not a cost worth
  optimizing against a reflow the user can see.

Failure is per row: the failing row keeps its identity, states the error, and
offers `Retry`. The other row stays fully functional. A single live region for
the whole panel is retained (`001` §5 pins exactly one `[aria-live]`);
announcements name the client so two rows cannot produce an ambiguous message.

## 7. Layout direction for `020`

One column, page-scrolled, in this order: keys → connect → endpoints and auth →
models → examples.

The rail **stays**. This was an open question when this document was written and
is now settled by measurement at `020`'s P gate, not by taste: a six-column key
table needs ~1064px inside a 912px table interior at 1280×720, so the fold
would have required a horizontal scroller and the decision rule refused it.
`020` §Rail decision carries the arithmetic.

What the phase delivers instead: the overview's two tracks (339px and 357px)
become one 708px track, taking panel interior from roughly 300px to 670px. The
three-band geometry becomes rail plus one content band.

Honest statement of the limit: this satisfies "3분할은 진짜 없애고 싶어" read as
*remove the three-band split*, and does not satisfy it read as *remove the rail
entirely*. Going literally single-column would mean dropping a key fact,
accepting a scroller, or switching from a table to cards — all worse than a rail
that attribution data now justifies. If the maintainer wants the rail gone
regardless, that is a scope decision for them to make, not an arithmetic one.
