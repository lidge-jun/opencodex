# Evidence: the dialog as the operator sees it

Captured from a real dashboard on 2026-09-13. A throwaway OpenCodex home with
`multiAgentMode: "v2"` and no stored acknowledgement, served on a spare port, read with a
headless browser. Not a mockup.

`dashboard-advisory-en.png` — the one-time advisory an existing v2 install raises after
updating. The sub-agent switch behind it still reads v2, because nothing was changed for
that operator: the notice is asking, not reporting.

`dashboard-advisory-ko.png` — the same dialog in Korean, showing the two answers the
request specified: 계속하기 and v1으로 바꾸기.

The selection dialog is the same component with `reason="selection"`; its heading and body
differ and its two answers do not. `gui/tests/subagent-surface-warning.test.tsx` covers that
variant, the backdrop dismissal, and the gate on all three mode switches.
