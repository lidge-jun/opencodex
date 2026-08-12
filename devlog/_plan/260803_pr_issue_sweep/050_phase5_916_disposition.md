# 050 — Phase 5: #916 disposition

## Scope note

This PR is security work on unfixed defects. Per `AGENTS.md`, reproduction
detail, bypass reasoning, and severity assessment for anything not yet public
belong in scratch space, not here. This document records only the disposition:
which hunks are kept, which are rejected, and what has to happen before any of
it lands. The working notes live under a `mktemp -d` path and are deleted when
the work closes.

## Verdict

`SALVAGE-5-HUNKS`. #916 is not superseded by #917, and it does not land as-is.

The expectation was overlap: #917 merged an hour before this audit and touched
`management-auth`, `auth-cors`, `bun-runtime`, and `server/index.ts`. But #917
resolved the *inbound* management principal — who may call the star route.
#916 authenticates the CLI's *outbound* management listener — whether the thing
answering on the port deserves the admin token. Different boundary, no overlap
in effect. The auditor confirmed the outbound path still misbehaves on current
`dev` after #917.

## Keep

1. **Vertex location validation** — new `src/providers/google-vertex-location.ts`
   single-label validator, checked in `src/adapters/google.ts` before ADC
   acquisition and again at the management write boundary through
   `providerManagementConfigError()`. Permits `global`, `us`, `us-central1`;
   rejects anything that changes the request authority. Regression in
   `tests/gcp-adc.test.ts`.
2. **Durable Bun runtime provenance** — `src/lib/bun-runtime.ts` accepts a
   recorded runtime only when the path names `process.execPath`, and the
   Bun-side override reselection is removed. Documented `ocx service install`
   overrides keep working because `bin/ocx.mjs` selects and stamps before Bun
   starts. Regressions in `tests/bun-runtime.test.ts`, `tests/service.test.ts`.
3. **Local management listener attestation** — new
   `src/lib/local-management-attestation.ts` (challenge + PID + port HMAC,
   timing-safe compare, fail-closed on malformed input), the runtime secret in
   `src/config.ts` (`atomicWriteFile()` already writes mode `0600` and hardens
   Windows ACLs before rename), start wiring in `src/cli/index.ts`, the attested
   `/healthz` in `src/server/index.ts`, and the listener challenge in
   `src/oauth/health.ts`.
4. **Proof-bound Claude destination provenance** — `bin/ocx.mjs` captures
   destination and token slots before Bun loads dotenv and binds the snapshot to
   a random argv proof; `src/cli/launcher-context.ts` enforces proof shape,
   rejects duplicates, allowlists slots, and clears the provenance variables.
   **Narrowed** — see the rejected hunk below.
5. **Documentation** — the corrected CI security-boundary comment and the
   external approval-policy section, which the auditor verified against the live
   API (`approval_policy=all_external_contributors`, no self-hosted runners
   registered).

## Reject

**`src/cli/claude.ts` no-context `?? []` fallback.** With no launcher context,
the PR strips genuine shell-exported API credentials and redirects to the proxy
marker. Direct `bun src/cli/index.ts` is explicitly supported
(`structure/01_runtime.md:9`), so this breaks a documented entry path: a user
who exported a real key in their shell loses it. Fail-closed handling is right
for the OAuth-bearing subscription destination and wrong for credentials with
unknown provenance. `tests/claude-auth-mode.test.ts` currently encodes the
regression as intended behavior and must be rewritten with the fix.

**`structure/06_docs-and-release.md` workflow table.** Written against the
pre-#899 workflow: it claims the Bun `test` job keeps PRs on hosted Windows.
Current reality is four Linux shards (`ci.yml:189-247`), full macOS
(`:304-349`), Windows only on main/preview push or dispatch (`:351-430`), and
the aggregate `ci` gate (`:485-556`). Rewrite, do not carry forward.

**`structure/01_runtime.md` decision log** — mixed. The threat description and
the launcher-proof choice are accurate; the paragraph recording direct-Bun
fail-closed behavior documents the rejected regression. Revise alongside the
implementation fix.

## Activation scenarios for the salvaged hunks

The PR's own tests are stronger than this doc's first draft, which listed test
files without saying what makes each guard fire. Recording the triggers so the
rebase does not quietly lose one:

| Hunk | Trigger | Observable proof |
|---|---|---|
| Vertex location | `provider.location` set to a value carrying `:`, `/`, or `#` | ADC acquisition never runs; management write returns a config error; `global`/`us-central1` still accepted |
| Bun provenance | Recorded runtime path that does not name `process.execPath` | Durable artifact keeps the launcher-stamped pair; unpaired late override ignored |
| Listener attestation | Fake listener answering `/healthz` on the configured port | No bearer in the outbound request; valid proof still authenticates the real listener |
| Claude destination | `ANTHROPIC_BASE_URL` present in dotenv but absent from the launcher snapshot | Destination replaced with the local proxy; the same variable exported by the parent shell is preserved |
| Direct-Bun credential (the fix) | `bun src/cli/index.ts` with a shell-exported key, no launcher context | Key preserved — this is the test that must fail with the `?? []` fallback restored |

## Conflict surface

`git merge-tree` reports exactly one conflicted file: `src/server/index.ts`.
#917 changed the management-auth import and the `/api` dispatch; #916 changes
the adjacent import/start/`/healthz` region. The resolution must retain
`managementPrincipal()` and the five-argument `handleManagementAPI(...)` call
while adding #916's attestation imports, the `startServer` secret argument, and
the proof response. `.github/workflows/ci.yml` and `src/server/auth-cors.ts`
auto-merge.

## Plan

Ordering correction: the first draft said this phase lands last because Phases
3–4 would move `src/server/index.ts`. That was wrong — they do not touch that
file, and the conflict is purely against #917, which has already landed. The
real dependency is Phase 2: both touch `src/config.ts`,
`src/server/auth-cors.ts`, and `tests/config.test.ts`. Phase 2 lands first so
this rebases onto a settled config surface.

1. Rebase onto `dev` at whatever tip Phases 1–4 produce; resolve
   `src/server/index.ts` preserving `managementPrincipal()`.
2. Fix the direct-Bun credential regression; replace the test that mandates it.
3. Rewrite the stale workflow table against #899's actual job graph.
4. Rerun focused security tests, typecheck, full suite, privacy scan.
5. **Keep the PR in draft pending explicit maintainer security review.** It
   touches authentication, credential handling, and the durable launcher —
   `MAINTAINERS.md` requires security review for exactly this surface. The
   audit is not that review, and an agent does not substitute for it.

## Accept criteria

- The five salvaged hunks apply on a rebased branch with the suite green.
- The direct-Bun path preserves a shell-exported credential, proven by a test
  that fails with the `?? []` fallback restored.
- The workflow table matches the current `ci.yml` job graph.
- Disposition and residual state recorded on the PR itself so @Ingwannu can see
  which parts were kept and why the rest was not.
