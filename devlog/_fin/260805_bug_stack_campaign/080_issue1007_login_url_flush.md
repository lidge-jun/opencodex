# 080 — Issue #1007: login authorization URL withheld under non-TTY stdout

Independent lane. Research: explorer batch F.

## Verified current state

- Codex login prints URL/instructions via `console.log` then enters up to
  150 two-second polls: `src/cli/account-auth.ts:79`; generic OAuth repeats
  the shape at `:118`. `RuntimeApiDeps` has stdin injection but no stdout
  writer (`src/cli/runtime-api.ts:17`). Existing tests capture `console.log`
  in-process, never a real pipe (`tests/cli-account.test.ts:306,367`).
- Diagnostic on pinned Bun 1.3.14: `console.log`, `process.stdout.write`,
  `writeSync`, and awaited `Bun.write(Bun.stdout,…)` were all pipe-readable
  within 500ms on the test machine — the sync fd write is still the
  strongest regression-resistant contract.

## Diff-level plan

MODIFY `src/cli/account-auth.ts`:
- Import `writeSync` from `node:fs`.
- ADD local `writeStdoutFully(text)`: UTF-8 encode; loop on partial
  synchronous writes to fd 1; reject zero-byte progress.
- Build ONE initial human-readable block per login branch (URL +
  instructions + flow id together — never the URL alone, which would
  reorder output) and synchronously write it before code submission,
  `--no-wait` handling, or polling.
- `--json` mode emits no human block.

MODIFY `tests/cli-account.test.ts` — parent pipe-timing regression +
JSON/no-wait assertions.

ADD `tests/helpers/account-login-pipe-child.ts` — invokes the real account
command handler with a fake management fetch; returns a URL/flow, then keeps
status unresolved long enough for the parent to prove the child is still
authenticating.

No production stdout-injection abstraction (test-only need).

## Tests / activation

Spawn the child with `stdout: "pipe"`, read incrementally with a sub-second
deadline: the authorization URL arrives while the child is still polling.
Matrix: Codex account URL under pipe; generic OAuth URL under pipe; stdout
redirected to a file; TTY ordering preserved; `--json --no-wait` emits one
valid JSON doc and no human prefix; missing URL keeps existing flow-ID/error
behavior; closed consumer/EPIPE → controlled CLI failure, not hidden
polling.

## Risks

- Sync writes can block on a full pipe — the bounded login block is far
  below pipe capacity.
- Partial writes handled explicitly; one unverified `writeSync` is weaker on
  unusual runtimes.
- The listener-lifetime concern in #1007 is out of scope.

## Accept criteria

- Pipe regression red→green; gates as 030.
