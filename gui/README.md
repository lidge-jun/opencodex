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
bun run doctor       # React Doctor vs origin/main (changed-scope, advisory)
bun run doctor:full  # Full-project React Doctor scan
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
| **React Doctor** (`bun run doctor`) | Advisory React health check pinned to react-doctor 0.7.8. Pre-push runs it only if `gui/` changed and never blocks the push. The CI workflow reports to the step log only |

Fix ESLint errors first. Use `doctor` / `doctor:full` for deeper React triage.
