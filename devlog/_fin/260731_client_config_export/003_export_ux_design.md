# 003 — Export UX design (Design Read + surface contracts)

Design judgment only. Component-level implementation belongs to `040`.
Governs every surface that hands a client config to a caller: CLI text, CLI
`--json`, management API, GUI panel, GUI file download.

## 1. Design Read

```yaml
---
name: opencodex client config export
colors:
  primary: "light-dark(#0d0d0d, #ececec)"   # existing --accent, unchanged
  accent:  "light-dark(#0d0d0d, #ececec)"
  background: "light-dark(#ffffff, #212121)"  # existing --bg
typography:
  heading: { fontFamily: OpenAI Sans, fontSize: 14px }   # --text-body / --weight-semibold
  body:    { fontFamily: OpenAI Sans, fontSize: 13px }   # --text-control
  machine: { fontFamily: ui-monospace, fontSize: 12px }  # --font-code / --text-label
iconography:
  system: "existing gui/src/icons"
  weight: "regular"
  domain: "library-subset"
---
```

Reading this as: a **handoff surface inside a developer console** — the screen
where a machine-readable artifact leaves the product and enters someone else's
config file. The reference is not a marketing "integrations" page; it is closer
to a CI provider's "copy this token" step or a package registry's install
snippet. The whole job is to make an exact string transfer without error.

Do's: reuse the API page's existing copy-on-click grammar; keep the generated JSON
visible before it is taken; name the destination path explicitly.

Don'ts: no new visual language for this feature; no illustrations, no per-client
brand marks, no gradients; never present a download as if it were applied.

### Dial setting

```
DESIGN_VARIANCE: 3
MOTION_INTENSITY: 1
Product density profile: D6
Reasoning: dense developer console, preserve redesign — this is an additive panel on an
existing monochrome infra surface, so variance and motion match the host and density
stays high because the payload is machine data.
```

Domain gate applies: this is an admin/ops surface, so the Liquid Editorial default
kit is explicitly NOT used. The host design system in `gui/src/styles.css` governs.

### Concept generation: skipped

UX-CONCEPT-GEN-01 exempts utility CRUD/dashboard surfaces, and a governing design
system already exists (monochrome OpenAI-console grammar, tokens in `styles.css`).
No new brand-visible composition is introduced. Skip recorded per the rule.

## 2. The one design decision

Export has two legitimate consumer shapes and they pull in opposite directions:

| Consumer | Wants | Failure if served the other |
|----------|-------|------------------------------|
| Agent / script | one exact JSON on stdout, no prose | prose in stdout breaks the parse |
| Human | to know WHERE the file goes and WHICH env var to set | bare JSON leaves them guessing |

**Resolution: one payload, four presentations.** A single pure function produces
the artifact; each surface decides only how to frame it. This is the existing
`printData(value, wantsJson, lines)` contract in `src/cli/runtime-api.ts:285`
generalized — human lines and machine JSON are two renderings of the same value,
never two code paths that can drift.

```
                    buildClientConfig(client, catalog, endpoint)
                                    |
                    +---------------+---------------+
                    |               |               |
              CLI --json      CLI human       GET /api/client-config
              (stdout JSON)   (JSON + path     (same JSON + metadata)
                               + env hint)            |
                                                +-----+-----+
                                                |           |
                                          GUI preview   GUI download
                                          (+ copy)      (.json file)
```

## 3. Lazy-User Gate

Applied to every decision point the feature introduces:

| Decision | Gate outcome |
|----------|--------------|
| Which client? | **Keep.** Genuinely divergent formats; no correct default exists. Segmented control, not a dropdown — two options should never hide behind a click. |
| Which OpenCode schema version? | **Delete.** V1 only (see `001` §2). Not user-facing. |
| Which models to include? | **Absorb.** System emits every visible non-disabled model. No picker. |
| Where to write the file? | **Absorb + demote.** Show the canonical path as copyable text; never write it for them. |
| Copy or download? | **Keep both, unequal.** Copy is primary (the common case is paste-into-existing-file); download is secondary. |
| Which env var? | **Absorb.** Fixed name per client, shown as a copyable export line. |

Primary action on the panel: **Copy JSON.** Everything else is secondary weight.

## 4. UX state contract

Per UX-STATE-01, meaning before styling. The panel has five states.

**Empty — no keys generated yet.** The config is still valid (the proxy admits
loopback callers), but a config referencing an unset env var will fail the moment
the user leaves loopback. So this is informational, not blocking: show the JSON,
plus a line stating that the referenced variable has no key behind it yet and
pointing at Generate key. Never disable export here — an agent may legitimately
want the shape before the key exists.

**Loading — catalog in flight.** Skeleton, because the structure is known
(panel head, code block, action row). The existing `DataSurfaceSkeleton`
in `gui/src/components/data-surface` is the house component. No spinner, and
never render a partial JSON that could be copied mid-flight.

**Ready.** JSON visible, model count stated, copy primary, download secondary,
destination path and env line present.

**Error — catalog fetch failed.** The client config cannot be honestly produced
without the model list, so do not emit a half-config. State that the model list
could not be read, offer retry, and keep the endpoint/base-URL portion visible
since it is known independently of the catalog. Never dead-end.

**Degraded — catalog partial.** Some models carry no authoritative context window
and therefore ship without a `limit` block (`002` §4). This is invisible in the
JSON, so the panel states it in one line: N of M models omit context limits, and
the client will apply its own defaults. Silence here would look like data loss.

### Progressive disclosure

Hidden by default: the destination-path detail (XDG resolution, project vs global
precedence) and the raw curl-equivalent. Reason: correct for the 90% case without
reading. Revealed in the same disclosure the API page already uses for
Authentication and Usage examples, so the grammar is consistent.

## 5. Download-specific design

The download is the surface most likely to mislead, because a file appearing in
`~/Downloads` feels like an applied change. Three rules.

**Filename encodes the client, not the product.** `opencode.json` and
`pi-models.json` — a file named `opencodex-export.json` tells the user nothing
about where it belongs. The name should match what the destination file is called
so the mapping is obvious.

**Downloading is never presented as applying.** The success announcement says the
file was downloaded and names the path it must be moved or merged into. Reuse of
the ClaudeDesktop precedent covers the mechanics; the wording is this unit's
responsibility.

**Merge semantics are stated, not implied.** The downloaded file contains ONLY our
provider block plus `$schema`. A user with an existing `opencode.json` must merge,
not replace — replacing would destroy their other providers and MCP config. One
line of text prevents a support issue that would otherwise be data loss.

Accessibility: the download button is a real `<button>`, the result is announced
through the existing live region, and the anchor trick stays an implementation
detail — never a bare `<a download>` styled as a button.

## 6. Placement

The API page is already being reworked (see the layout proposal from the same
session: connect bar on top, catalog below). Export belongs to the connect
cluster, not the catalog: it is part of "how do I point a client at this proxy,"
which is exactly what the connect bar answers.

Concretely, the connect bar's trailing action group gains a third entry beside
"curl example" and "All endpoints" — a "Client config" disclosure that opens the
export panel. Keeping it there means the page still has one primary action
(Generate key) and export does not compete with the catalog for vertical space.

If the layout rework has not landed when `040` runs, the panel goes into the
existing left column below Endpoints, with the same internal design. The panel is
layout-independent by construction.

## 7. Anti-slop check

Concept-level judgment for this direction:

- Not generic: the panel reuses the host's existing copy-on-click and disclosure
  grammar rather than introducing an "integrations card" pattern.
- Domain-correct: monochrome, dense, machine-data-first — matches an infra console
  and would be wrong for a consumer surface.
- No decorative layer: no client logos, no illustrated empty state, no emoji, no
  gradient, no motion beyond the existing feedback transitions.
- The one novel element (segmented client switch) already exists in the proposed
  connect bar as the protocol selector, so it is a reuse, not an invention.
