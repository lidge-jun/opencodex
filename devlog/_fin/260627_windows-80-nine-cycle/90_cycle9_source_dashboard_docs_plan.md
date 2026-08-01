# Cycle 9 - Source checkout dashboard/dev docs clarification

## Scope
- Clarify the source-checkout development path reported by Windows users: `bun run dev` starts the proxy API, not the dashboard route at `/`.
- Keep this docs-only; no source runtime change.

## Planned diff
- `README.md`: add a short note under Development explaining `bun run dev` exposes `/healthz`, `/v1/responses`, and `/api/*`; use `ocx gui` for packaged dashboard or `cd gui && bun dev` for frontend development.
- `README.ko.md`: same clarification in Korean.
- `README.zh-CN.md`: same clarification in Chinese if the matching section exists.
- `docs-site/src/content/docs/getting-started/installation.md`: mirror the source-run clarification.
- Korean/Chinese docs-site installation pages if present: mirror the same clarification.

## Acceptance
- A clone user no longer expects `bun run dev` alone to serve GUI `/`.
- Docs remain concise and command examples are copy-paste-ready.
- Typecheck/targeted docs grep pass.

## Verification
- `rg -n "bun run dev|cd gui|proxy API|프록시 API|代理 API" README.md README.ko.md README.zh-CN.md docs-site/src/content/docs/getting-started/installation.md docs-site/src/content/docs/ko/getting-started/installation.md docs-site/src/content/docs/zh-cn/getting-started/installation.md`
- `bun x tsc --noEmit`

## Commit
- Atomic commit: `docs: clarify source dashboard dev flow`
