# wp3 — GUI: the approval dialog and its two triggers

## Component

`gui/src/components/SubagentSurfaceWarningModal.tsx`, modelled on
`OAuthTosWarningModal.tsx`: a native `<dialog>` opened with `showModal()` so focus
trapping, the backdrop and Escape come from the platform.

Props:

| Prop | Meaning |
| --- | --- |
| `reason` | `"selection"` when the operator just clicked base or v2, `"advisory"` for the one-time post-update notice. |
| `mode` | The mode being selected, or the mode currently stored, depending on `reason`. |
| `docsUrl` | The published guide. |
| `onContinue` | Keep or apply the non-v1 mode. |
| `onChooseV1` | Apply v1. |

Both actions are real buttons in `.modal-actions`. `v1으로 바꾸기` is the primary, because
it is the recommended answer; `계속하기` is the ghost. Escape and the backdrop resolve to
the same outcome as `계속하기` for the advisory (the stored mode is kept) and to a no-op
for a selection (the click is abandoned and the segmented control does not move).

## Triggers

**Selection.** `Models.tsx` `setMultiAgentMode` and `use-dashboard-data.ts` `switchMaMode`
stop writing directly for `"default"` and `"v2"`. They stage the pending mode, render the
dialog, and write only from `onContinue`. Selecting `"v1"` stays immediate: confirming a
move toward the safe default would be noise.

**Advisory.** The dashboard reads `multiAgentSurfaceAdvisory.required` from the `/api/v2`
poll it already runs and opens the dialog once per load while it is required. `계속하기`
sends the acknowledgement alone; `v1으로 바꾸기` sends the mode and the acknowledgement
together.

## Translations

Nine locales live in `gui/src/i18n/`: en, ko, ja, zh, zh-TW, fr, de, ru, tr. Keys:

- `subagentSurface.selectionTitle`, `subagentSurface.selectionBody`
- `subagentSurface.advisoryTitle`, `subagentSurface.advisoryBody`
- `subagentSurface.continue`, `subagentSurface.switchToV1`, `subagentSurface.learnMore`

Korean carries the literal `계속하기` and `v1으로 바꾸기` the user asked for; the other
locales carry their natural equivalents.
