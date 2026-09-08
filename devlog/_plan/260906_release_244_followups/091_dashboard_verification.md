# Dashboard visual verification

Source PR #3764 at 42689e02a60ca230e53dee1f872864af5d6b0872. Hosted CI 34029024036 passed the runtime matrix, gates and installation checks. Gates built artifact 9988003853 from checkout 274d2f8cb7ad8c381db29fa1799ad446c034da39. Its GUI tree 1eff4e4d3485133600e4fdb6e9ba78c36c0bf1e4 equals the reviewed source tree. The artifact SHA256 is c4f507ac7ab269170d6ec82e5351b8a526072524baa95403046e52293ae831de.

The real built frontend was served on an isolated loopback fixture API. Displayed model selections, request totals, memory figures and the deliberately long preview version come from synthetic fixtures. No live provider or running OpenCodex service was used. No repository local test suite, typecheck or build was run.

## Observed results

| Scenario | Evidence | Result |
| --- | --- | --- |
| Desktop 1440 | [capture](screenshots/dashboard-1440.png) | Controls align, long model labels stay inside their buttons |
| Split-screen 1024 | [capture](screenshots/dashboard-1024.png) | Shared control rows stack when the content area narrows |
| Tablet 768 | [capture](screenshots/dashboard-768.png) | No horizontal page or control overflow |
| Mobile 390 | [capture](screenshots/dashboard-390.png) | Radio group, effort pair and version badge fit |
| Narrow 320 | [capture](screenshots/dashboard-320.png) | No horizontal page or control overflow |
| Narrow shadow row | [capture](screenshots/dashboard-320-lower.png) | Full Korean heading is one 21px line; source badge wraps below |
| Keyboard selection | [open](screenshots/dashboard-320-keyboard-open.png), [saved](screenshots/dashboard-320-interaction.png) | Visible keyboard ring; high to xhigh produced one fixture PUT and persisted the value |
| Empty/repeated choice | [capture](screenshots/dashboard-320-empty-repeat.png) | Selecting no limit twice keeps the null state and readable placeholder |
| Dark/reduced motion | [capture](screenshots/dashboard-1440-dark.png) | Readable control labels and boundaries; reduced-motion media active |
| Two-times pinch zoom | [capture](screenshots/dashboard-1440-zoom2.png) | Zoomed viewport captured; reflow is established by the separate CSS-width matrix |

Each PNG has its signature, nonzero size and exact requested width by 900px height verified. Main inspected every referenced frame; two independent rubric-bound reviewers passed the final set. DOM measurements show page scrollWidth equals viewport width and every select label remains within its button. The shadow heading height equals its 21px line-height at all five widths. Fresh browser console capture contained no output; loaded assets and fixture calls used the loopback origin.

The first artifact at eb35039fd reproduced a long delegation label reaching 1425px beyond a button ending 1218px. ec88720e6 added scoped span shrink/ellipsis rules. The first narrow capture then exposed a Korean heading orphan; 42689e02a wraps shadow metadata below the heading on narrow containers. These were observed corrections, not inference from green CI.

Shared Select post-save focus behavior and unchanged sticky chrome were not represented as repaired. Malformed free-form input is not exposed by these select-only layout controls; HTTP parsing is unchanged. Source compatibility and the 15-line artifact workflow addition received independent reviews. The upload remains contents-read, uses an immutable action pin, uploads only built output and expires after seven days.

## Teardown

The fixture process was terminated, the isolated Chrome profile was stopped, and both listening ports were confirmed closed after the captures. Raw captures, exact invocations, DOM measurements and the validated three-scenario QA receipt remain in the local session evidence directory. This publication commit adds documentation and captures only; the GUI tree is unchanged from 42689e02a.
