# opencodex dashboard

This is the Vite/React dashboard used by `ocx gui` in packaged installs.

## Source checkout development

Run the proxy and dashboard as two separate dev processes:

```bash
# terminal 1, repo root
bun run dev:proxy

# terminal 2, repo root
bun run dev:gui
```

The root proxy dev server exposes API endpoints such as `/healthz`, `/v1/responses`,
and `/api/*`. It serves `GET /` only when a packaged dashboard build exists at
`gui/dist`, so a fresh clone should use the Vite dev server while editing the UI.

## Build

From the repo root:

```bash
bun run build:gui
```

That command installs/builds this dashboard and copies the production assets into
the package layout used by `ocx gui`.

## Lint and React Doctor

```bash
cd gui
bun run lint         # ESLint — hard local/CI gate (`GUI lint` in CI)
bun run doctor       # React Doctor vs origin/main (changed-scope, gates on findings)
bun run doctor:full  # Full-tree React Doctor (gates on findings)
```

From the repo root:

```bash
bun run doctor:gui              # same as gui doctor
bun run doctor:gui:full
bun run setup:hooks             # pre-push runs doctor when gui/ changed
```

| Tool | Role |
|------|------|
| **ESLint** (`bun run lint`) | Hard gate in CI and expected before merge |
| **React Doctor** (`bun run doctor`) | Gating React health check pinned to react-doctor 0.9.11 (`blocking: warning`). Pre-push runs it only if `gui/` changed and fails the push on findings. The CI workflow fails the job on any finding |

Fix ESLint errors first. Use `doctor` / `doctor:full` for deeper React triage.

## Sidebar version browser regression

```bash
cd gui
bun run build
bun run test:sidebar-version
```

This opt-in check uses an installed Chrome/Chromium through its local DevTools
protocol, with no Playwright dependency or automatic browser download. Set
`CHROME_BIN` to the executable when it is not on PATH (including macOS/Windows).
It fails with an actionable error when the browser or production build is missing;
it does not silently skip assertions.

The offline fixture uses the production CSS bundle and App header markup, not
copied CSS rules. Across 128 combinations of light/dark theme, eight viewport
widths, four release/prerelease/build strings and two font sizes, it verifies full
text visibility, containment, short release text staying on one line, and
no intersection with the mobile drawer close button. A short badge stays beside
the product name whenever the measured row budget allows it; larger OS font
fallbacks may move the complete badge below the name rather than clip it. Results and a screenshot are
written to `.tmp/sidebar-version-browser/`; pass an output directory after the
command to change it. No management API, proxy credentials, or live providers are
used.

Chrome's sandbox stays enabled by default. `CHROME_NO_SANDBOX=1` is an explicit
opt-in only for an already-isolated root test container that cannot run Chrome's
sandbox; it is not needed or recommended on a normal workstation.
