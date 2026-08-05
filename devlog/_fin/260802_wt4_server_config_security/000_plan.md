# wt4 — Server CORS + atomic config writes (research)

Worktree: `/Users/jun/.codex/worktrees/260802-wt4-server-config` (branch `codex/wt4-server-config`, off `dev`).
Two must-fix bugs on the server/config boundary, both security-adjacent.

## Scope

### Bug A — PR #850: browser-extension CORS origins all collapse to `null`

- Root cause: `URL.origin` serializes `chrome-extension://...` (and other non-special schemes) as the string `"null"` per the WHATWG URL Standard. Comparing that value makes every browser extension origin look identical — the allowlist cannot distinguish the configured extension from any other, while rejecting `*` leaves users no safe path.
- Fix shape (from PR, re-verify): canonicalize authority-based opaque origins as `scheme + "://" + authority` instead of the WHATWG `null` serialization; allow only the configured extension ID; cover both preflight and `/v1/models` data-plane requests; document in EN + zh-CN config references.
- Grounding: `src/server/index.ts` (`setCorsOrigin` at :136/:345; `origin_rejected` data-plane blocks at :424/:463/:580/:614/:635/:669).
- Severity: high — this is the CORS security boundary; a wrong comparison here is an origin-confusion defect, not a cosmetic one.

### Bug B — PR #869: atomic config writes destroy symlinked destinations

- Root cause: `atomicWriteFile`/`atomicWriteFileAsync` write a temp file beside the literal destination path and `rename(2)` over it. rename replaces the directory entry, so when the destination is itself a symlink the link is destroyed and replaced by a regular file. Breaks dotfiles-managed setups (`~/.codex/config.toml` symlinked into a tracked repo): the first injected write silently converts it to a real file and the repo stops receiving updates; the live config keeps working so the divergence is invisible.
- Grounding: `src/config.ts:107` (`atomicWriteFile`), `src/config.ts:184-187` (`atomicWriteFileAsync`); callers include `src/config.ts:1627` (config write), `:2070` (pid), `:2098` (runtime port state).
- Severity: high — silent data divergence; nothing surfaces it until the user diffs their dotfiles repo.
- Fix shape (from PR, re-verify): resolve the destination through `realpath` before choosing the temp-file location so the rename lands beside the real file, preserving the link.

## Claim ledger

| # | Claim | Source | Status |
|---|-------|--------|--------|
| 1 | `new URL("chrome-extension://...").origin === "null"` per WHATWG URL | WHATWG URL Standard §4.7 (opaque origin for non-special schemes; serializes as `"null"`); applies equally to `moz-extension://` and `safari-web-extension://`; compare scheme+host or `runtime.getURL("/")` instead | verified |
| 2 | rename(2) over a symlink replaces the link, not the target | POSIX.1-2024 `rename()` (Open Group pubs 9799919799) + Linux man-pages 6.18 `rename(2)`: "if newpath refers to a symbolic link, the link will be overwritten"; standard mitigation = realpath/canonicalize destination first (check/use race caveat: use dirfd-based resolution for security-sensitive paths) | verified |
| 3 | All atomicWriteFile callers audited for symlink destinations | PR #869 body | unverified — executing session must enumerate |

## Out of scope

- Relaxing the CORS allowlist model itself (exact-match stays).
- Windows ACL hardening of the temp path (that is wt2/#840's lane; coordinate if both touch `atomicWriteFileAsync` — wt4 owns the realpath fix, wt2 owns the memo release; land in that order to minimize conflicts).
