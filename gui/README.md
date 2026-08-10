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
