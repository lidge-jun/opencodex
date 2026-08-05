# wt4 — Implementation roadmap (re-verify at P before building)

Branch `codex/wt4-server-config` off `dev`. Security-boundary lane: per AGENTS.md, CORS/origin changes need explicit security review before merge.

## Bug A — #850: extension CORS origin identity

File map:

- MODIFY `src/server/auth-cors.ts` — the actual WHATWG `"null"`-collapse comparison lives in `isExtraAllowedOrigin` (:81-89, `new URL(allowed).origin === new URL(origin).origin`), with `isSameOriginAsRequest` (:64) adjacent; `setCorsOrigin` (:21) only sets `_corsOrigin`. Canonicalize authority-based opaque origins as `scheme + "://" + authority` instead of the `"null"` serialization; allow only the configured extension ID; `*` stays rejected. Externally verified basis: WHATWG URL §4.7 collapses all three extension schemes to `"null"`; compare scheme+host, never `.origin`.
- COVER preflight AND every data-plane rejection path: at P, grep `origin_rejected` in `src/server/index.ts` and cover ALL ten sites (:424/:463/:580/:614/:635/:669/:694/:788/:819/:853 as of dev@3195c7194 — re-grep, do not trust this list). `src/server/index.ts` itself is listed for coverage sites only; the comparison change is in `auth-cors.ts`.
- DOCS: EN + zh-CN configuration references.

Acceptance + activation:

1. Configured extension ID passes preflight and `/v1/models`. Activation: request test with `Origin: chrome-extension://<allowed-id>`.
2. A DIFFERENT extension ID is rejected (this is the actual bug — today both serialize to `"null"`). Activation: adversarial request test.
3. `moz-extension://` and `safari-web-extension://` get the same canonicalization treatment (verified same spec rule). Activation: parametrized scheme tests.
4. Non-extension origins (http/https localhost rules) unchanged. Activation: existing suite.

## Bug B — #869: realpath before atomic rename

File map:

- MODIFY `src/config.ts:107` (`atomicWriteFile`) and `:184` (`atomicWriteFileAsync`) — resolve the destination through realpath before choosing the temp-file location, so the rename lands beside the real file and the symlink survives. Verified basis: POSIX.1-2024 `rename()` + Linux `rename(2)`: "if newpath refers to a symbolic link, the link will be overwritten."
- Audit EVERY caller: at P, grep `atomicWriteFile` across `src/` (~21 files as of dev@3195c7194) and classify each for symlink-destination exposure. Do not treat any inline list as exhaustive. Explicitly named because it is the most symlink-sensitive caller in the tree: `src/oauth/store.ts` (credential store). Also confirmed callers: `src/config.ts:1627/:2070/:2098`, `src/responses/state.ts`, `src/codex/journal.ts`, `src/codex/inject.ts`, `src/grok/inject.ts`, `src/codex/history-provider.ts`, `src/update/job.ts`, `src/update/notify.ts`, `src/claude/desktop-3p.ts`, `src/codex/{refresh,runtime,features,account-store,quota}.ts`, `src/codex/catalog/*`.
- Caveat from research: canonicalization introduces a check/use race; for the config path this is acceptable (user-owned dir), but note it in the code comment — do not claim race-free.

Acceptance + activation:

1. `~/.codex/config.toml` as a symlink into a temp "dotfiles repo": after an injected write, the symlink still exists and the target file carries the update. Activation: fixture test asserting `lstat` is still a link post-write.
2. Non-symlink destinations byte-identical behavior. Activation: existing suite.
3. Coordination: wt2's #840 touches `atomicWriteFileAsync` memo logic. wt4 lands the realpath change first (or rebases); both units name this file in their ledgers.

## Verification gate

`bun run typecheck` + `bun run test` + `bun run privacy:scan`; security review sign-off per MAINTAINERS.md before merge (CORS boundary).
