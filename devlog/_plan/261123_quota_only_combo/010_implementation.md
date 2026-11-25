# Quota-only Combo failover

## Goal

Allow callers to select an OpenAI-first or Anthropic-first route that tries the matching API key after the included allowance runs out, then tries a chosen model on the other subscription and its API key. Existing direct routes and Combos retain their behavior. A metered leg still requires explicit consent.

## Work and acceptance

- [x] Reproduce failures through the public Responses and Messages endpoints with a fake upstream. Cover rate limits, confirmed quota or billing exhaustion, unknown quota, transient cooldowns, local budget refusals, cancellation, and the streaming commit boundary.
- [x] Add a per-Combo mode for ordered failover. Advance only after confirmed exhaustion. Evaluate cached evidence before dispatch and bounded upstream evidence after dispatch. Preserve declared order, scoped fallback policy, consent, tool-loop pinning, and the shared send budget.
- [x] Add a same-model constraint across providers. Publish both settings through the Combo management contract and CLI. Exercise omitted settings and explicit clears during partial updates.
- [x] Add both presets, metered target labels, separate consent, quota-only mode, and a preview beside the ordered list. The review replaced the React Flow view with semantic HTML.
- [x] Provide a disposable fixture and validate the editor, both public inference endpoints, and the repository checks.

## Demonstration

Both methods produced the same four targets, models, quota policy and paid-call consent. The
manual route uses the current editor and takes advantage of its automatic model defaults.

| Route | Manual | Preset |
| --- | ---: | ---: |
| OpenAI first | 16 actions in 448 ms | 3 actions in 85 ms |
| Claude first | 16 actions in 451 ms | 3 actions in 86 ms |

The presets remove 26 of 32 actions across both routes, an 81% reduction. The editor now marks
recognized paid APIs automatically, so the manual path also took two fewer actions per route.
The browser test
includes a 25 ms pause between actions and measures through management API read-back. The
time is for one automated run and does not estimate human completion time. The preview
reported the consent stop at step 2 and the model-lock stop on both routes. After a keyboard
move, focus stayed inside the moved target.

| Scenario | OpenAI first via Responses | Claude first via Messages |
| --- | --- | --- |
| Subscription serves | 1 send, HTTP 200 | 1 send, HTTP 200 |
| First API key serves | 2 sends, 85 ms | 2 sends, 82 ms |
| Other subscription serves | 3 sends, 121 ms | 3 sends, 131 ms |
| Last API key serves | 4 sends, 168 ms | 4 sends, 170 ms |
| All targets exhausted | 4 sends, HTTP 400, 172 ms | 4 sends, HTTP 429, 168 ms |
| Temporary throttle | 1 send, HTTP 429, 42 ms | 1 send, HTTP 429, 45 ms |

The legacy OpenAI-first route sent to the paid key on the same temporary throttle and
returned HTTP 200 after two sends in 82 ms. Quota-only saved one paid attempt and returned the
throttle in 42 ms. The upstream fixture uses a 35 ms delay per send. Production latency and
live account billing were outside this measurement.

## Isolation

Use a checkout separate from the user's existing branch. Keep `HOME`, `CODEX_HOME`, and `OPENCODEX_HOME` disposable for executions. Start the server directly and keep the real proxy port, service configuration, credentials, agents, and user sessions out of the fixture. The public seams agreed in the plan are Responses, Messages, Combo management and CLI, and the Combo editor in a separate browser context.

## Reproduce locally

From the repository root with root and GUI dependencies installed, start the real backend and
Vite against the local upstream fixture.

```sh
bun --no-env-file scripts/dev-fallback-fixture.ts
```

The fixture binds the dashboard on `127.0.0.1:15173`, the proxy on `18601`, and fake upstream
on `18602`. Open the dashboard at `http://127.0.0.1:15173/#models/combos`. Use a fresh fixture
for the browser benchmark because it creates and checks four named Combos. In a separate
terminal run the following command and pass an optional screenshot destination.

```sh
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  bun --no-env-file scripts/check-fallback-fixture.ts /tmp/opencodex-fallback-preview.png
```

Press Ctrl+C in the fixture terminal to release the ports and remove its disposable home.
The benchmark handles its separate browser profile and emits JSON lines with the measured
actions, HTTP statuses, attempt order and elapsed time.

## Verification

The first tests reproduced an unwanted paid call on a transient throttle, unsafe reuse of a
generic cooldown, a model-change guard bypass, missing CLI and management support, and a
tool continuation that moved after primary recovery. Each was rerun after implementation.

- Backend regression run passed 448 tests across the Combo consent, tool continuation,
  cooldown, zero-output, quota provenance, exhausted-error, management, routing classifier
  and CLI partial-update files.
- Dashboard regression run passed 51 tests across the Combo editors and their strategy,
  alias, capability and dirty-state round trips. Both Vite builds and the i18n lint passed.
- Repository typecheck, fixture script typecheck, file-size ratchet, structure, privacy and generated CLI
  surface checks passed. The full repository suite covers additional platform integrations.
  This local validation used focused tests and a fresh macOS headless Chrome run.
- Review regressions cover credential replacement, recognized paid APIs reached by redirect,
  separate keyed and loopback consent, repeated tool continuations, preview labels and model
  locks, and the subscriptions-only preset. The preview uses a semantic ordered list and
  React Flow was removed.


## Dashboard refinement

The workflow leads the editor. Its preview groups the stop reason, paid consent and ordered
targets. At narrow widths the editor fills the workspace and returning to the list restores
focus. The changes apply to the current dashboard. The classic overlay retains the original
workspace components. Pointer movement updates
the dragged row directly and commits the reordered list on release. The arrow buttons remain
available for keyboard operation.

Scoped verification covered 33 GUI tests and a browser run with the disposable providers.
The browser run exercised pointer and keyboard reordering, consent and focus restoration,
the light and dark themes, and the 390 px layout.

## Review follow-up

The strict policy requires consent for any destination without a recognized subscription or
an explicit local loopback transport. It resolves redirects in the dashboard and rechecks the
effective destination at dispatch. A continuation needs its remembered serving route. A
committed output ceiling leaves the target available on the following request.
Claude Code tool turns reuse the validated, caller-scoped identity carried by the Messages bridge.

Dashboard saves send target metering, paid-call consent and the two failover settings only when
they differ from the Combo the editor loaded. A poll that changes them reloads the editor, so a
stale editor cannot restore a flag the CLI cleared. The dashboard reads each provider's billing
class from `GET /api/combos`, which classifies it the way the quota-only dispatcher does.

The Codex pool fixture distinguishes fresh account quota evidence from an ambiguous 429 on a
sibling. The Anthropic fixture drives real pool selection with mocked rejected quota windows
on Responses and Messages. The local browser fixture also exercises both directed chains and
the transient-throttle stop without requiring any provider credentials.
