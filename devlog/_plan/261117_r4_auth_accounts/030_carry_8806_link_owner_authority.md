# 030 carry #8806: explicit SSH routes need owner authority

Author: luvs01 (Co-authored-by trailer). Source head 39daa91973.

## Change

- MODIFY `src/server/management/link-route-request.ts`: `splitRouteRequest(value, ctx)` returns `403 forbidden` for a supplied `explicitRoute` unless `pairedSession(ctx) || adminLoopback(ctx)`, after the form checks and before any SSH, identity-file inspection, host-state change or journal replay.
- MODIFY `src/server/management/link-enrollment.ts`: `probe`, `confirmHost`, `apply` pass `ctx`.
- MODIFY `structure/remote-link.md`, `structure/gui-and-management-api.md`, en/es `guides/remote-link.md` (from the PR).
- MODIFY `tests/server/link-enrollment-explicit-route.test.ts`: the PR's authenticated harness (real bootstrap, pairing redemption, admission) and its refusal/compatibility cases.

Review nit kept: form errors are reported before the authority check, which returns grammar feedback only and matches the PR's documented order.

## Proof

Authority tests fail with the `src/` check removed and pass with it. `bun test tests/server/link-enrollment-explicit-route.test.ts tests/server/link-enrollment.test.ts tests/server/link-enrollment-operation.test.ts tests/server/link-management-routes.test.ts`.

