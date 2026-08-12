# WP3 — verification evidence

C-RENDER-GROUNDING-01 applies: a layout change is not verified by a green suite
or a produced-but-unread screenshot. The row was rendered, observed, and
inspected.

## How it was observed without touching the live proxy

The user's proxy on 10100 runs the installed v2.10.0 build, which does not carry
this change. So a second proxy was started from the dev tree on port 10399 under
an `OPENCODEX_HOME` from `mktemp -d`, observed, and then stopped by PID. The
10100 proxy answered 200 before and after.

That isolation is not politeness. A dev-tree start against the real home would
have rewritten the user's client configs mid-session.

## What the render showed

At 1440 px:

- API keys render as **one full-width row** between the summary strip and the
  card grid — the requested `위쪽에 한 라인`.
- The row carries the title, `No keys issued`, and a `Manage keys` button. **No
  badge**, so nothing on it says "Not applied" about a credential.
- The card grid begins with **Codex CLI**. There is no keys card anywhere in it.
- The summary reads `Clients detected 9` / `Configured clients 3`, so the labels
  now state the scope their numbers actually measure.

At 390 px the row keeps its shape: title and detail stack on the left, the
action stays on one line, nothing clips.

`agbrowse snapshot --interactive` resolves the control as
`e75 button "Manage keys"` — a real button in the accessibility tree, which is
what earns platform Enter/Space behavior. That is the assertion happy-dom cannot
make, which is why the audit moved it here.

![keys row at 1440px](/Users/jun/.browser-agent/screenshots/screenshot_1785774782191.png)

## Gates

| Gate | Result |
|---|---|
| root `bun x tsc --noEmit` | clean |
| `gui` typecheck | clean |
| `gui bun test tests` | **564 pass, 0 fail**, 107 files |
| `bun run lint:gui` | clean, 0 errors 0 warnings |
| `bun run lint:i18n` | clean |
| `gui bun run build` | succeeded |
| `tests/api-key-count-loader.test.ts` | 6 pass |

The lint run earned its place: it rejected the two `throw new Error` strings as
untranslated UI text. They are rejection reasons that never reach a user — the
row renders `integrations.detail.keyUnavailable` instead — so one carries a
scoped disable with that reason, and the second disable was removed once eslint
reported it as unused. A blanket disable would have hidden the next real one.

## Tests that had to change, and why that is the point

Four existing tests failed after the change, each asserting the contract this
phase removes: `keys` as a client row, `unknown` as its state, 5 settled rows,
11 unsettled, and an applied total of 6. They were updated rather than deleted,
and two now assert the inverse — that no `[data-client="keys"]` exists inside
`.integration-cards`, and that a failed key read renders `data-key-state`
`unavailable` rather than "no keys issued".

The loader test is the one that would have caught the original defect: a
`{ keys: "nope" }` body used to become "No keys issued" through `readOptional`,
which is a claim about the account of the user that a malformed response cannot
support.
