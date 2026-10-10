# 011 — wp2 execution packets (cycle plan)

**Continuity (LOOP-CONTINUITY-01).** wp1 D concluded: "roadmap locked at r5 (003_contract_index.md); next wp2 = evidence +
projection as PR A from dev; guards follow as wp5 stacked on it." This cycle keeps that direction. Re-verification:
`origin/dev` has not moved since the lane branched at c15037b324, so every 010 anchor still holds.

Contract: `003_contract_index.md` + `010_supervision_evidence_projection.md` (later amendments win). Implemented by four
gpt-6.1-sol workers in parallel in this worktree, with disjoint write scopes. Workers do not commit; main reviews and
commits in dependency order (W1 → W2 → W3 → W4). No branch operations by workers.

| Worker | Write scope (only these files) | Depends on |
|---|---|---|
| W1 evidence | NEW `src/service/desktop-supervision.mjs`, `src/service/desktop-supervision.d.mts`; MODIFY `src/service/desktop-startup.ts`; tests `tests/service/service-desktop-startup.test.ts`, `tests/service/service-desktop-startup-linux.test.ts` | 003 shapes |
| W2 projection | `src/codex/autostart-health.ts`, `src/server/startup-health-cache.ts`, `src/cli/status.ts`, `src/cli/index.ts` (≤ +3 lines), `src/cli/doctor.ts`, `src/cli/resolve.ts`; tests `tests/service/autostart-health.test.ts`, `tests/service/service-desktop-startup-health.test.ts`, `tests/cli/cli-status-startup-health.test.ts`, `tests/cli/cli-status-json.test.ts`, `tests/cli/cli-resolve.test.ts`, `tests/codex-integration/doctor.test.ts` | W1 interface (imports it; codes against 003 shapes, injects fakes in tests) |
| W3 GUI | `gui/src/pages/startup-shared.ts`, `gui/src/startup-health-ui.ts`, `gui/src/pages/startup-sections.tsx`, `gui/src/i18n/*.ts` (new key in all 11 locales), `tests/gui/startup-health-ui.test.ts` | 003 shapes only |
| W4 docs | `structure/desktop-shell.md`, `structure/ops/service-and-sidecars.md`, `structure/runtime.md` (replace, cap 600), `docs-site/src/content/docs/guides/desktop-app.md` + its ko locale | 003 |

Verifier (main runs after integration; each worker runs only its own test files):
`bun test tests/service/service-desktop-startup.test.ts tests/service/service-desktop-startup-linux.test.ts tests/service/service-desktop-startup-health.test.ts tests/service/autostart-health.test.ts tests/cli/cli-status-startup-health.test.ts tests/cli/cli-status-json.test.ts tests/cli/cli-resolve.test.ts tests/gui/startup-health-ui.test.ts tests/codex-integration/doctor.test.ts`,
`bun run typecheck`, `bun run lint:gui`, `bun run build:gui`, `bun run structure:check`, `bun run privacy:scan`,
plus the read-only live check (lane CLI `status --json` / `resolve --json` on the reporting Mac; expect
`startupSource: "local-supervision-override"`, `startup.desktop.supervisor`, `recommendedCommand: null`).
GUI screenshot: GUI dev server with a stubbed `/api/startup-health` (supervised, login unverified), uploaded to `pr-assets`.

Escalation: a worker that needs a file outside its scope reports back; main amends this packet (no mid-B improvisation).
Resource bounds: lane worktree only; no network beyond gh for this repo; no live-process mutation.


Architect reflection (Kant, same handle): **ALIGNED** — scopes disjoint and complete; dispatch.ts:732 and
config-routes.ts:413 pass the startup object through unchanged; all tests extend registered files.

Audit (reviewer 01a11e4b): GO-WITH-FIXES (blockers=1), folded:
- Add `cd docs-site && bun install --frozen-lockfile && bun run build` (deps prepared once; local cache) to main's verifier.
- Add `bun scripts/file-size-ratchet.ts` (no `--update`).
- Live checks split: status → `startupSource`, `startup.desktop.supervisor`, `startup.recommendedCommand === null`;
  resolve → `supervisor.kind === "desktop"`, `supervisor.runtimePid === liveness.pid`, `supervisor.supervisorPid` = Desktop app pid.
