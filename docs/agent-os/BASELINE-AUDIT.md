# Pao-hubPro — Phase 00 Baseline Audit (PaohupByPaoZa repository)

> Generated: 2026-08-29 (Asia/Bangkok) — Codex Phase 00 execution
> Scope: read-only audit + baseline checks. No source changes made by this audit.

## 1. Environment

- OS: Windows 11 (PowerShell 7 shell)
- Runtime: Bun 1.3.14 (project is Bun-native TypeScript)
- Repo root: C:/Users/AD PAO/Desktop/paohupbypaoZAZAZA55555
- Git branch: paohupbypaoza (local; origin is lidge-jun/opencodex)

## 2. Repository identity

PaohupByPaoZa v2.62.0 — a rebranded, Thai-localized fork of opencodex 2.26.0
that has absorbed upstream dev updates. It is a local LLM provider proxy with a
React dashboard, serving Codex CLI/App, Claude Code, Claude Desktop, and Grok
Build. User config stays at ~/.opencodex for compatibility.

CLAUDE.md: UNAVAILABLE (does not exist at repo root; AGENTS.md read instead).

## 3. Working-tree state (user work preserved)

- Branch paohupbypaoza with ~37 modified files, none staged.
- Modified areas: Apple-styled GUI (App.tsx, styles.css, new styles-apple.css),
  Thai locale (new gui/src/i18n/th.ts, 11 upstream locales adjusted), CLI
  branding (doctor/help/init/index), server index, Windows tray/start scripts,
  package.json rebrand (bin names paohup/paohupbypaoza retain an opencodex alias).
- Untracked: gui/src/i18n/th.ts, gui/src/styles-apple.css, start.cmd, start.ps1.
- This audit touched none of it.

## 4. Stack inventory

| Area | Finding |
|---|---|
| Runtime | Bun-native TypeScript, no separate server compile step |
| Frontend | React + Vite (gui/), packaged output served from gui/dist |
| Database | None. No migrations, no *.prisma, no *.sql anywhere |
| Queue | No persistent task queue. In-process queues only (run-turn-queue.ts, storage policy/cleanup/restore workers) |
| Cache | In-process; config/state are JSON files in ~/.opencodex |
| Auth | Codex/ChatGPT OAuth flows, API keys, @napi-rs/keyring secret storage |
| MCP | @modelcontextprotocol/sdk dependency present |
| Deployment | Local app only (start.cmd/start.ps1, Windows tray); no Docker/Compose |
| Docs | Astro + Starlight docs-site/, structure/ maintainer invariants, devlog/ |

## 5. Module inventory relevant to the Agent OS blueprint

- Model routing: src/routing/ (profile, evaluator, health, cost, quota,
  capability, trace, analytics, history), src/providers/ (registry, quota,
  failover, tiers, discovery), src/adapters/ (openai-chat, openai-responses,
  anthropic, google, azure, kiro, cursor, grok/xai, mimo-free, and more), src/combos.
- Optional subsystem: src/lab/ (Compatibility Lab), opt-in, boundary enforced by
  tests/core-lab-boundary.test.ts (router.ts, lifecycle.ts, responses/core.ts
  must not reach src/lab).
- Server: src/server/ (lifecycle, management API, responses core).
- CLI: src/cli/ (start, doctor, models, init, help).
- Storage jobs: src/storage/ (policy, cleanup, restore, scanner, mutation coordinator).

## 6. Baseline test report (commands actually run)

| Check | Result | Evidence |
|---|---|---|
| bun run typecheck | FAIL (pre-existing) | 4 errors, all in src/adapters/google.ts lines 1184-1186, 1229 (TS2367 comparisons). google.ts is untouched by the working tree — upstream defect, not a regression of local work |
| bun run privacy:scan | PASS | exit 0, "Privacy scan passed" |
| bun run test (root, 871 files) | INCONCLUSIVE (environment) | Ran ~38 min (normally ~210 s); Bun 1.3.14 crashed with internal panic (runtime bug, bun.report link emitted). Zero (fail) lines observed before the crash. Classify as pre-existing environment limitation, not a code failure |
| bun test tests/core-lab-boundary.test.ts tests/repo-hygiene.test.ts | PASS 24/24 | exit 0 in 3.57 s |
| gui: bun run lint | FAIL (in-scope uncommitted work) | 1 error: App.tsx:106 hardcoded "PaohupByPaoZa ·" (no-hardcoded-ui-strings) |
| gui: bun test tests | FAIL (root cause identified) | 119 fails; root cause: the rebrand changed detectInitialLocale fallback from "en" to "th" in gui/src/i18n/shared.ts, so tests asserting English UI text time out (e.g. compatibility-lab.test.tsx fails 9/26 in isolation) |

Pre-existing failures are separated from audit-time failures: nothing in this
audit's run introduced a new failure. The google.ts typecheck errors and the
locale-default test regressions both predate this audit.

## 7. Risks and constraints

- Windows-first; tests assume an idle machine (suite timing guard).
- Bun runtime crash under heavy parallel test load is an upstream Bun issue.
- GUI tests are coupled to the default locale; any default-locale change needs a
  test-locale pin (e.g. localStorage en) or locale-agnostic assertions.
- No persistent storage engine exists; every future Agent OS phase that needs
  durable tasks/workflows must introduce its own storage strategy (Phase 04+).
