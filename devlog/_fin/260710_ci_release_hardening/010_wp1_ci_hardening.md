# 010 - WP1 CI diagnosis and hardening

Work class: C4 (release/CI integrity). Archetype: spec-satisfaction repair.

## P - Evidence and root cause

- Cancelled run: `29063166533`, branch `dev`, SHA `1cc2dd87`.
- The job was not cancelled by concurrency. Five matrix jobs passed; the
  `windows-latest` test job reached its eight-minute job timeout.
- The last completed assertion was the first Kiro reset/broken-pipe retry case.
  The next test, `retries the per-attempt TimeoutError`, creates a Promise that
  subscribes to `abort` after receiving a 1ms timeout signal. On a slow Windows
  runner the signal can already be aborted before subscription, and EventTarget
  does not replay that event. The mock then never settles.
- `service-lifecycle.yml` contains a separate false-green path:
  `curl .../healthz || echo "healthz not ready yet"`. It also uses fixed sleeps,
  can skip the Linux crash-restart assertion when no PID is found, does not
  verify macOS/Windows stop state, and skips cleanup after an earlier failure.

## Threat model

- Assets: CI verdicts, npm release eligibility, service-manager lifecycle
  behavior, GitHub token scope.
- Trust boundaries: repository workflow -> ephemeral GitHub runner -> release
  workflow; OS service manager -> proxy health endpoint.
- Attacker/failure capability: malicious workflow change can widen token scope;
  flaky timing can block or falsely green a release; a broken daemon can leave
  only manager metadata while health is dead.
- Controls: `contents: read`, bounded jobs/polls, exact state/health assertions,
  deterministic test mocks, `!cancelled()` teardown, independent review.

## Build scope

1. `tests/kiro-retry.test.ts`: make the timeout mock reject immediately when
   `signal.aborted` is already true, otherwise subscribe once. Do not increase
   the CI timeout or add a retry/quarantine. The first mocked fetch must delay
   its subscription until the 1ms signal is already aborted, then prove it
   settles with `TimeoutError` and the second attempt succeeds.
2. `.github/workflows/service-lifecycle.yml`:
   - add `contents: read`, ref-scoped concurrency, and per-job timeouts;
   - Linux: poll at most 20x1s for both active systemd state and HTTP 200; on
     failure print `systemctl status` and user journal. Crash proof requires a
     positive old MainPID, successful kill, a different positive MainPID, and
     HTTP 200 within the same bound. Quote `whoami`, split `id -u` declaration
     from assignment, and leave the file clean under actionlint/shellcheck;
   - macOS: poll at most 20x1s for both the launchd label and HTTP 200; after
     `ocx stop`, require the label absent and the health request to fail;
   - Windows: use `Get-ScheduledTask -ErrorAction SilentlyContinue` plus bounded
     `Invoke-WebRequest -TimeoutSec 2`; readiness requires task state `Running`
     and HTTP 200. After stop, the task must still exist but not be `Running`,
     and the health request must fail. Failure prints task info and service log;
   - cleanup runs with `if: ${{ !cancelled() }}` so it executes after ordinary
     failures but does not restart work during cancellation. It uninstalls and
     verifies the manager artifact is absent on every OS. Linux stop and every
     OS cleanup also require a bounded health request to fail, preventing a
     detached proxy process from surviving after manager removal.
3. `tests/ci-workflows.test.ts`: pin the important workflow invariants and
   negative assertions (no swallowed health failure, exact timeout-test guard,
   least privilege, bounded jobs, cleanup condition). These are repository
   invariant tests, not a YAML parser substitute.
4. `.github/workflows/ci.yml` and `service-lifecycle.yml`: keep the eight-minute
   CI timeout so an actual hang still fails loudly; pin mutable action tags to
   the official tag target SHAs recorded 2026-07-10:
   `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0`,
   `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`, and
   `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`.

## Verification

- Repeated focused Kiro retry test runs, including an explicitly pre-aborted
  signal activation case.
- `bun test tests/kiro-retry.test.ts tests/ci-workflows.test.ts`.
- `actionlint .github/workflows/ci.yml .github/workflows/service-lifecycle.yml`
  as the independent workflow syntax/expression parser.
- `bun x tsc --noEmit`, `bun run privacy:scan`, full `bun test ./tests/`.
- Push one reviewed commit, fast-forward `dev` and `preview`, and require fresh
  successful Cross-platform CI plus Service lifecycle runs on the same SHA.

## Resource bounds

- Write scope: `.github/workflows/ci.yml`,
  `.github/workflows/service-lifecycle.yml`, `tests/kiro-retry.test.ts`,
  `tests/ci-workflows.test.ts`, and this devlog unit.
- Credentials: existing `gh` auth only; no secrets read or changed.
- Wall clock: 60 minutes for WP1.
- No force push, blind rerun, test retry, quarantine, or timeout inflation.

## LOOP-PESSIMIST

- If the race fix still hangs on Windows, return to P with new logs; do not widen
  the job timeout.
- If a service-manager assertion is not portable on hosted runners, preserve
  health as the primary oracle and record the platform limitation instead of
  converting it to a warning.
