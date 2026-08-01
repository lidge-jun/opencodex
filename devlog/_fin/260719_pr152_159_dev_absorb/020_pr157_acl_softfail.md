# 020 — PR #157 absorb: Windows icacls ACL soft-fail

## 1. Scope and locked inputs

Absorb community PR #157 from immutable source head
`e19f38beeafb919d8d88afff9379728771caa748` (`codex/source-pr157-e19f38be`)
onto local `dev` with substantial maintainer redesign (Sol verdict FAIL).
No push. Attribution per `000_plan.md` — given the redesign depth, the landing
is maintainer-authored with `Co-authored-by: Wibias` except where a hunk is
source-faithful.

Source delta (2 files, +113/−31): `src/lib/windows-secret-acl.ts` rewrite of the
icacls runner (Bun.spawnSync + windowsHide, retry, module lock, soft-fail
ETIMEDOUT/EPERM/EACCES on required paths), `tests/windows-secret-acl.test.ts`
source-text contract test.

`git merge-tree` clean (`23c3bcf112d0`).

## 2. Sol review verdict (2026-07-19, lane A)

`VERDICT PR#157: FAIL`

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | P1 | Every non-timeout icacls failure becomes `EPERM` → soft-failable, defeating `required:true`; secret published with `ok:false` discarded by atomic-write callers (config.ts:74-87) | FOLD — redesign: `icaclsOnce` preserves the real spawn error; only `exitedDueToTimeout` maps to `ETIMEDOUT`, non-zero exits become a distinct `EICACLS` error carrying the exit code. Soft-fail on required paths applies ONLY to `ETIMEDOUT` (the reported field symptom); every other failure keeps throwing. Availability-over-confidentiality beyond timeout needs a user decision — NEEDS_HUMAN residual if the field error returns |
| 2 | P1 | `/remove:g` failure swallowed → broad ACEs may remain while returning ok:true | FOLD — verify outcome locale-independently: on `/remove:g` non-timeout failure, run `icacls <path> /findsid <sid>` through the same runner seam for each of `*S-1-1-0`, `*S-1-5-11`, `*S-1-5-32-545` (`/findsid` reports matches regardless of localized account rendering); a hit on any SID → propagate the original error; all clean → continue |
| 3 | P1 | 3×15s retries per command × 3 commands × 3 paths ≈ 135s stall in loadConfig — worsens the reported symptom | FOLD — total-deadline budget: one `Date.now()`-anchored deadline of 5s per `hardenSecretPath`/`hardenSecretDir` call shared by all three icacls steps; per-step timeout = remaining budget; at most one retry per step and only if budget remains. NEW module-level `failedPaths` Set: a path whose harden timed out is not retried for the process lifetime (cleared by the existing test-only reset) |
| 4 | P2 | Module-local boolean lock serializes nothing across processes; sync calls already serialized in-process | FOLD — drop the `withIcaclsLock`/`icaclsHeld` layer entirely |
| 5 | P2 | Test only greps source text; no failure-path activation | FOLD — TWO seams: (i) injectable `type IcaclsRunner = (args: string[], timeoutMs: number) => IcaclsResult` via `setIcaclsRunnerForTests`; (ii) injectable platform predicate `setPlatformForTests("win32")` so the win32-only guard (windows-secret-acl.ts:122-125,155-158) is reachable in CI on macOS/Linux (both mirror the module's existing test-only reset conventions and are reset in afterEach). Deadline uses an injectable clock `setNowForTests(fn)` — no real sleeps. Drive cases: (a) runner throws ETIMEDOUT → required harden returns `{ok:false}` + `console.warn` spy fired; (b) runner throws EPERM → required harden throws; (c) `/remove:g` fails + `/findsid` reports a hit → throws; `/findsid` clean → succeeds; (d) deadline: clock advances past budget between steps → path lands in `failedPaths`, second call short-circuits without invoking the runner. Keep one public-entry integration test on the real platform guard (skipped unless win32) |

## 3. Landing plan

1. Maintainer-authored commit (+Co-authored-by Wibias): Bun.spawnSync runner
   with windowsHide + honest error codes + total-deadline retry + failed-path
   cache + timeout-only soft-fail + activation tests. Body cites PR #157 head
   `e19f38be` and states which source behaviors were kept vs redesigned.

## 4. Verification

- `bun run typecheck` exit 0.
- `bun test tests/windows-secret-acl.test.ts` pass, including new failure-path
  activation tests (C-ACTIVATION).
