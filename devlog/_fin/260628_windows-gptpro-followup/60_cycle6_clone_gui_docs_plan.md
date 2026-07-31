# Cycle 6: Clone GUI Development Experience Polish

## Goal

Make source-checkout users understand that the root dev command starts the proxy, while the dashboard is a separate Vite app in development or a packaged build in releases.

## Scope

- MODIFY `package.json`:
  - Keep `dev` behavior unchanged for compatibility.
  - Add `dev:proxy` as the explicit proxy-only alias.
  - Add `dev:gui` as a root convenience command that runs the GUI dev server from `gui/`.
- MODIFY `README.md`:
  - Update the Development section to show `bun run dev:proxy` and `bun run dev:gui`.
  - Clarify that `GET /` is available only when `gui/dist` exists, and source checkout users should run the GUI dev server separately.
- REPLACE `gui/README.md`:
  - Remove the Vite template text.
  - Add opencodex-specific dashboard dev instructions, including proxy prerequisite and common localhost confusion.
- MODIFY `tests/install-scripts.test.ts` or a docs/static test:
  - Assert root package scripts expose `dev:proxy` and `dev:gui`.
  - Assert GUI README is opencodex-specific rather than generic Vite template text.

## Non-goals

- Do not change packaged GUI build behavior.
- Do not make the proxy serve Vite dev assets in this cycle.
- Do not alter runtime API endpoints.

## Verification

- `bun test tests/install-scripts.test.ts tests/server-auth.test.ts`
- `bun x tsc --noEmit`
