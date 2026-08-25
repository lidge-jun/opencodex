# Cursor Bugbot rules

- Review in English. Report concrete correctness, security, privacy, and regression risks with file and line references; skip purely stylistic comments.
- This runtime is Bun-native TypeScript. Flag Node-only APIs, compile-step assumptions, and changes that break `bun run typecheck` or `bun run test`.
- Treat authentication, credentials, OAuth, workflows, release tooling, dependency installation, and secret/logging changes as blockers requiring human security review.
- Never suggest logging request bodies, API keys, tokens, or account identifiers. `bun run privacy:scan` must remain green.
- Protect the optional-Lab boundary: `src/router.ts`, `src/server/lifecycle.ts`, and `src/server/responses/core.ts` must not import `src/lab/` directly or transitively. Activation belongs behind the synchronous gate in `src/server/index.ts`.
- Sync PRs must preserve `vendor/main`, `vendor/dev`, and current fork `main`; never recommend force-pushing `main` or resolving ordinary sync hunks with Cursor Autofix.
- Require `bun run typecheck` and `bun run test` for non-trivial runtime changes. A resolved thread is not acceptance evidence; only a successful Bugbot check on the current head is.
