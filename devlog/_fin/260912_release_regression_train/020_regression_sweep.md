# wp3 — regression sweep

The sweep covers `e432cf565a..dev`, the window that never had a finished CI run. It
also revisits the higher-risk subsystems across the full `main..dev` range, because
that whole delta is what a 2.51.0 user receives.

## Method

Parallel read-only lanes on `xai/grok-4.6`. Each lane owns a disjoint read scope and
returns findings as exact `file:line` or SHA citations, separating confirmed facts
from suspicion. Lanes never write, never run local product commands, and never touch
git state. The main session synthesizes, accepts or rebuts each finding, and decides.

## Risk ranking

Account pool and quota routing sit directly on the request path. Codex config injection
and restore write the user's own `config.toml`. Remote workspace and remote control add
new surface but default off behind `OCX_REMOTE_WORKSPACE_ENABLED`. Provider catalog,
integrations and clients change what the CLI exposes. GUI, docs and i18n are visible but
rarely release-blocking.

## Exit

Every commit in the window assigned to at least one lane with a recorded verdict, and a
defect register that classifies each finding as release-blocking, user-visible minor, or
harmless.

## Window composition

Of the 57 non-merge commits, 20 touch `src/`, 13 of those reach the user request path, and
the remaining 37 are GUI, tests, docs, or devlog. `src/router.ts` and
`src/server/lifecycle.ts` are untouched; the hub is `src/server/responses/core.ts`, which
six commits share. That file belongs to one lane alone so the read scopes stay disjoint.

## Lanes

| Lane | Read scope | Commits |
|---|---|---|
| 1 | `src/codex/routing.ts`, `src/combos/resolve.ts`, `src/providers/quota*.ts`, `src/server/management/provider-routes.ts` | d42a1363dc (routing), f18541b8f5, 7418ef8eb2, 0bcb43e266 |
| 2 | `src/server/responses/core.ts`, `chat-completions.ts`, `claude-messages.ts`, `adapter-resolve.ts`, `src/responses/custom-tool-compat.ts`, `src/bridge.ts`, `src/vision/plan.ts`, `src/web-search/index.ts` | d42a1363dc (core), de2042628d, d608d7fb0a, 17b3d3fe99, d6723f7f3b, d27db6dd56, b09ef15c6f (partial), 843486a3b8, 8949fd073f |
| 3 | `src/claude/inbound*.ts`, `src/types/config.ts` | e114bc97b5, 954c1f28fc |
| 4 | `src/codex/inject.ts`, `inject-coordination.ts`, `history-provider.ts` | 7f76d736c2, 1338e96c10, be203dd4a4 |
| 5 | `src/oauth/**`, `src/adapters/**`, `src/providers/registry.ts`, devin-cli migration | fa4226a9ba, b09ef15c6f (partial), d6fb87197a, 96041e7833 |
| 6 | `src/remote-control/**`, `src/update/job.ts` | 71857fac92, 726ddc7fc0, f378947111, e090ad65cd |
| 7 | `src/integrations/**`, `src/clients/config-export*`, `src/cli/**`, management config/integration routes | 90975e9fea, 1feec1bdc0, 75a8ec8f78 |
| 8 | `gui/src/**`, `gui/tests/**` | catalog stack, Combo clock and draft, Cline dialog |

Lane 2 runs first because everything else can then ignore the hub file.

## Already on the register

Lane 4's own fixture was the first finding, and it came from CI rather than the sweep:
`tests/codex-integration/codex-inject-integration.test.ts` asserts that an unreadable
pre-image aborts capture, but it created that condition with
`spyOn(fs, "readFileSync")` on the child's `require("node:fs")` handle. Production binds
`readFileSync` as an ESM named import, so the mock intercepted nothing and the test ran
entirely undenied. It fails identically on Linux and macOS, which means #4342 landed red
and dev has been red ever since. The repair replaces the mock with a real `chmod`.
