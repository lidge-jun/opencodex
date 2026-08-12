# wp1 execution notes (P-phase stale check, 2026-08-02)

## Stale check results

- `010_implementation.md` line refs: auth-cors.ts `isExtraAllowedOrigin` confirmed live at :81-89 in the pre-fix form; `setCorsOrigin` :21. `origin_rejected` sites in `src/server/index.ts` = 10 (grep-confirmed), all funneled through `isAllowedRequestOrigin`/`isAllowedManagementOrigin` → both call `isExtraAllowedOrigin`, so ONE predicate fix covers every data-plane + management-plane rejection site.
- Bun URL behavior verified locally (primary proof): `chrome-extension://abc123/page.html`, `moz-extension://u-u-i-d/`, `safari-web-extension://UUID/` all serialize `.origin` as `"null"` with `host` populated.
- Docs drift: `docs-site` configuration reference was split into domain subpages (commit 7fdb2cb8e). The `corsAllowOrigins` row now lives at `docs-site/src/content/docs/<locale>/reference/configuration/server.md` (:19-20) for all five locales (EN, zh-cn, ko, ja, ru). The PR #850 doc hunks DO NOT APPLY to current dev — docs must be re-based onto the subpage rows.
- PR #850 state: OPEN, CONFLICTING vs dev. Maintainer review blocker (locale doc drift) was already fixed by the contributor in a346ad60, so the fetched diff head is review-clean. Code+test hunks APPLY CLEAN to dev@478354ee8 (`git apply --check --include='src/**' --include='tests/**'`).

## wp1 execution decision

Apply the maintainer-reviewed PR #850 diff for `src/server/auth-cors.ts`, `src/types.ts`, `tests/server-auth.test.ts`, `tests/server-loopback-host-gate.test.ts` verbatim (credit eachann1024), then re-write the five `server.md` rows by hand in the new subpage location with the same content the PR used (authority-based extension origins supported; `*` is not a wildcard).

Rationale: the implementation is small, already maintainer-reviewed, and its test shape (live server preflight + data-plane + unit-level cross-scheme and `*` rejection) matches the acceptance criteria in `010_implementation.md` exactly. Hand-rewriting an equivalent fix would add risk, not value.

## Acceptance (carried from 010, mapped to PR tests)

1. Configured extension ID passes preflight + `/v1/models` — covered by the new `server-auth.test.ts` case (204 + allow-origin echo; 200 data-plane).
2. Different extension ID rejected — covered (403 live; false unit).
3. Cross-scheme isolation (`moz-extension://<same-id>` rejected) — covered by unit test.
4. `*` rejected — covered by unit test.
5. Non-extension behavior unchanged — existing `server-auth` / `server-loopback-host-gate` suites must stay green.
6. Docs: five locale `server.md` rows updated; locales must not contradict EN.
