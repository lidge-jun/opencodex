# WP4 — one dialog, two more switches

> **Rev 4** after audit round 4 and the re-scope (`007`). Two switches, not
> four: Codex and Desktop moved to the sibling unit and render exactly as they
> do today — badge and settings link, no switch. The `partial` surface is gone
> with them. This is WP4, the last phase of this unit.

## Only Grok gets a dialog

One confirmation, not two (UX-LAZY-01, `002` §gate). Grok's disable edits a file
another program reads, so it confirms. Claude Code flips a field in our own
config, breaks nothing on disk, and is undone by the same switch — a
confirmation there is friction with no payload.

Grok's copy says re-enabling REGENERATES the fence from the current model list.
It must not promise a byte-for-byte restore: that was an earlier revision's
design and the writer never made that promise (`012` §Undo is the enable path).

## A refused disable never opens a dialog

`GET` carries `disableBlocked` (`030`), so a switch whose disable would be
refused — a foreign-home service, an orphaned fence marker — renders disabled
with the reason beside it. Opening a consequence dialog for an action that
cannot succeed asks the user to confirm a decision we have already made for
them (audit r4 #8).

Direction and copy: `002_consequence_dialog_ux.md`. This doc is the wiring.

## IN

1. `gui/src/pages/integrations/ConsequenceDialog.tsx` — NEW.
2. `gui/src/pages/integrations/native-api.ts` — NEW: client for `030`.
3. `gui/src/pages/integrations/IntegrationsOverview.tsx` — MODIFY: switches for
   Claude Code and Grok; dialog gating for Grok only.
4. `gui/src/pages/integrations/overview-clients.ts` — MODIFY: `toggle` is no
   longer file-clients-only.
5. `gui/src/pages/integrations/refusal-copy.ts` — MODIFY: the native branch
   (Rev 5 B1). `integration-api.ts` stays untouched: the native guard lives in
   `native-api.ts`, and `FILE_INTEGRATION_CLIENTS` is NOT widened.
6. `gui/src/i18n/*.ts` — six locales.
7. `gui/src/styles-integrations.css` — dialog styles.
8. `gui/tests/consequence-dialog.test.tsx` — NEW.
9. `gui/tests/overview-state-merge.test.ts` — NEW: the precedence rules below.

## One state authority

WP3 adds `/api/native-integrations` while the overview keeps its five detail
reads, and rev 1 left the two unreconciled: the switch would follow one payload
while the badge followed another, so an out-of-order refresh could render a card
that says applied with a switch that says off (audit #11).

Precedence, in one pure function beside `buildOverviewRows`:

- **`applied` / switch state** — the native payload wins. It is the writer's own
  view and it is what the PUT just changed.
- **`state` badge** — derived from the SAME native payload, so badge and switch
  can never disagree.
- **`detail` line** — the per-client reads keep it: they carry the facts the
  native payload has no business knowing (auth mode, model count).
- **Not yet settled** — if the native payload has not arrived, the row is
  `unknown` and the switch is DISABLED. A switch whose state we are guessing is
  worse than one the user cannot touch for a moment.
- **Not yet implemented** — a client the native payload does not list has no
  switch at all. Distinct from unsettled: one is "wait a moment", the other is
  "this cannot be toggled here yet", and rendering a disabled switch for the
  second would promise a control that is not coming this release.
  Codex and Claude Desktop are in exactly this state until the sibling unit
  lands.

`OverviewCard` changes to read `row.applied` rather than `row.status`, which
also removes the file-client-only assumption baked into the card this morning.

## Rev 5 — wp4-cycle A-gate (verdict FAIL, 2 blockers; all accepted, none rebutted)

**B1 — the native refusal never reaches `describeRefusal`.** 030's "same
shape, no second code path" is false as shipped: `isIntegrationRefusalEnvelope`
rejects the native envelope on all three checks — `code` not in
`REFUSAL_CODES` (`integration_*` only), `clientId` not in
`FILE_INTEGRATION_CLIENTS`, and no `state` field at all
(integration-api.ts:119-144). A native refusal would surface as the raw
English `error` string in all six locales. The widening, as recommended by the
reviewer: `isIntegrationRefusalEnvelope` stays untouched; `native-api.ts`
defines its OWN guard for `NativeRefusalEnvelope` plus a `NativeApiError`, and
`refusal-copy.ts` gains a native branch keyed on the four reasons with
localized copy REPLACING the English server message. `"claude"|"grok"` must
NOT be added to `FILE_INTEGRATION_CLIENTS` — `toggleIntegration` would then
type-accept them and target the wrong route. IN list gains
`gui/src/pages/integrations/refusal-copy.ts`.

**B2 — the dialog's stated model does not solve focus.** RestoreDialog renders
`<dialog open>` — no `showModal()`, no top layer, no focus trap, no backdrop
dismiss, no focus restoration; only escape. The component that actually solved
all four is `ClientConfigDialog.tsx` (`showModal()` at :44, `cancel` +
`.modal-backdrop-dismiss` at :58-59) with focus restoration via the
`restoreFocusRef` pattern in ClientConfigPanel.tsx:42-58. ConsequenceDialog is
modelled on THAT. happy-dom has no top layer, so "focus-trapped" evidence is
assigned to the real-browser loop (already mandated); escape and backdrop are
happy-dom-tested per client-config-panel.test.tsx:244-262,285+.

**M3 — the card DOES need structural change.** Delete "no structural change":
the switch currently renders only when `row.status` is set and `applied` comes
from `status` (IntegrationsOverview.tsx:65,86,397). The card reads `row.applied`
and the row's own state/installed. Also built here, because they do not exist:
the card's refusal notice area and its normal message slot (today a card
refusal lands in the page-level `bulkResult` Notice).

**M4 — the Grok undo sentence is hedged for the non-loopback case** (002 is
internally inconsistent otherwise): the dialog's undo slot becomes conditional
copy, and the enable-time message owns the caveat.

**M5 — `home_mismatch` keeps the server's message after the Korean lead**, the
conflict/unsafe pattern (refusal-copy.ts:72-73): the two homes exist only
inside that string and 002 says they are load-bearing.

**M6 — `non_loopback_removed` copy branches on `changed`**: `true` names the
removed block, `false` says there was nothing to remove. The rendering keys on
`reason` AND `changed`, not `reason` alone.

**L7 — `installed` follows the native payload too** (the precedence list
previously assigned only applied/badge/detail): an installed-but-unfenced Grok
counts as detected.

**L8 — bulk disable stays file-clients-only**, stated so no one "fixes" the
asymmetry by sweeping Grok past its dialog gate.

**L9 — the six-locale gate is the GUI build** (`tsc -b`, locales are
`Record<TKey, string>`), not the root typecheck.

**Nits:** this unit's only confirm button is "해제" ("복원" belongs to the
sibling unit); "client absent from the native payload renders no switch" is a
forward-contract with no live trigger today.

## Dialog component

Modelled on `ClientConfigDialog.tsx`, the component that actually solved the
modal contract here: `showModal()` for the top layer (which is what makes the
focus trap real), a `cancel` handler for escape, a `.modal-backdrop-dismiss`
button for backdrop dismissal, and the `restoreFocusRef` pattern from
ClientConfigPanel.tsx:42-58 so focus returns to the switch that opened it
(Rev 5 B2 — RestoreDialog's `<dialog open>` solves only escape). Differences:
it takes structured content rather than one body string, and its confirm
button is named by the caller.

```tsx
export interface ConsequenceCopy {
  titleKey: TKey;
  changesKey: TKey;       // what is written or removed, and where
  breakageKey: TKey;      // what stops working
  undoKey: TKey;          // ONE hedged key — the hedge lives INSIDE the string
                          // because NativeStatus carries no bind field to
                          // branch on (Rev 5 M4; the server is committed)
  sideEffectKey?: TKey;   // rendered only when present
  confirmKey: TKey;       // names the action, never "확인"
  vars?: Record<string, string>;  // the literal path
}
```

Four slots in fixed order (`002` §Structure). `sideEffectKey` is optional and
its paragraph is omitted entirely when absent. Grok has no side effect, so its
dialog renders four slots and no fifth; the slot exists because the sibling
unit's Codex dialog needs it for the restart warning.

The path is interpolated from the live status payload, never hardcoded: a user
with `GROK_HOME` set must see THEIR path or the dialog is lying.

## Card wiring

`OverviewRow.toggle` widens from `FileIntegrationClientId | null` to
`OverviewClientId | null`. The card changes structurally (Rev 5 M3): it reads
`row.applied` and the row's own state/installed instead of `row.status`, the
switch renders whenever `toggle` and `onToggle` are set (not only for file
clients), and the card gains the two slots that do not exist today — a refusal
notice area and a normal message slot. The row builders stop returning `null`
for Claude Code and Grok.
Codex and Claude Desktop keep `toggle: null` and render as they do today.

Gating lives in the overview, not the card:

```ts
const requestToggle = (row: OverviewRow, next: boolean) => {
  // Claude Code flips one boolean in our own config and moves nothing on disk,
  // so a confirmation there is friction with no payload (UX-LAZY-01, 002 §gate).
  if (next || row.id === "claude" || row.toggle === null) return void commit(row, next);
  setPendingToggle(row);   // Grok: confirm first
};
```

Enabling is never gated. The dialog exists because removal touches files other
programs read; adding our block back is the reversible direction and the state
the product ships in.

## Refusals

Rendered in the card's notice area, not a second modal (`002` §Refusals are not
dialogs). `describeRefusal` gains the four reasons these two clients can
produce — `orphaned_marker`, `home_mismatch`, `not_installed`, `config_busy`. Its
`snapshotPath`/`residual` handling is NOT exercised here: neither toggle writes
a snapshot, so no refusal from this module carries one. That code stays for the
six file clients, untouched.

The `home_mismatch` copy must NOT say "stop the service" — the trigger is a home
mismatch, not a running service (`001` §The guard I described wrong). It names
both homes and leaves the resolution to the user.

### Success messages, not just refusals

Two PUT responses are successes that still need to say something. Both come from
enabling Grok under a non-loopback bind (`002` §TWO outcomes):

| `reason` | Card state after | Rendering |
|---|---|---|
| `non_loopback_removed` | 미적용 | the card's normal message slot, not error styling |
| `non_loopback_superseded` | 연결됨 | same slot, and the copy says the block was not written by this request |

The second matters more than its rarity suggests: the card flips to 연결됨 for a
block this request did not write. Rendering it silently would leave the user
believing their toggle produced that state. It is a success with a caveat, so it
is styled as a message rather than an error — a refusal notice would imply the
policy action failed, and it did not.

Both are driven by `reason` on a 200 response; the switch position follows
`state` from the same payload, as everywhere else.

There is no `partial` surface in this unit: `stripGrokConfig` writes atomically
and Claude Code writes one field, so neither can half-apply. It returns with the
two clients that can.

## Verification

A dialog is a render artifact, so C runs the render-grounding loop
(C-RENDER-GROUNDING-01), not just a mounted-component assertion:

1. Open Grok's dialog in the real browser.
2. Screenshot, and READ the screenshot back — a captured-but-unread screenshot
   is not observation.
3. Assert the rendered Korean text names the real path from the live payload and
   carries the HEDGED undo sentence (002: regenerates the fence when opencodex
   is on a loopback address), not the unconditional promise of earlier revisions.
4. Drive a full disable→enable round trip for BOTH clients and confirm the card
   state and the server state agree afterwards.

## Acceptance

- [ ] Claude Code and Grok both toggle both directions from the overview.
- [ ] Grok's toggle-off opens a dialog; Claude Code's does not.
- [ ] Codex and Desktop render NO switch — badge and settings link only.
- [ ] Enabling never opens a dialog.
- [ ] The dialog names the live path from the payload, not a constant.
- [ ] Grok's dialog says re-enabling regenerates the fence; it does NOT promise
      a byte-for-byte restore.
- [ ] A `disableBlocked` client renders a disabled switch with its reason, and
      clicking it opens no dialog.
- [ ] Both non-loopback success reasons render their own message; a test asserts
      `non_loopback_superseded` says the block was not written by this request
      and that the card reads 연결됨 (audit r10).
- [ ] Neither success reason is styled as an error.
- [ ] The confirm button reads "해제", never "확인" ("복원" belongs to the
      sibling unit; this unit ships one dialog).
- [ ] A refusal renders in the card notice with its localized explanation.
- [ ] `home_mismatch` copy does not tell the user to stop a service.
- [ ] Badge and switch never disagree: a test drives every combination of
      settled/unsettled native payload against each detail payload.
- [ ] An unsettled native payload disables the switch rather than guessing.
- [ ] A client absent from the native payload renders NO switch, not a disabled
      one.
- [ ] Six locales carry every new key.
- [ ] Dialog is keyboard-reachable, escape-dismissible, focus-trapped.
- [ ] The Grok dialog's browser screenshot is read back, not just captured.
- [ ] gui test, gui lint, and the GUI build (`tsc -b` — the six-locale
      `Record<TKey, string>` gate) green.
