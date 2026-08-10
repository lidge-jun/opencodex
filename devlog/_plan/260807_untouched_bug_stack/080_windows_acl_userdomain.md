# 080 — #1149: ACL hardening trusts USERDOMAIN

## Defect

`currentWindowsUser()` in `src/lib/windows-secret-acl.ts` builds the icacls
principal as:

```ts
return domain ? `${domain}\\${username}` : username;
```

`USERDOMAIN` is essentially always set — on a machine that is not domain-joined
it holds the COMPUTER NAME — so the `domain ? ... : username` branch never
takes the fallback the comment describes. Every machine gets
`DOMAIN\User`, and on a workgroup box that is `COMPUTERNAME\User`.

That form is not always what the effective token accepts: a renamed computer, a
Microsoft-account login (where the local profile name and the account name
differ), or an AzureAD-joined machine can all produce a principal icacls cannot
resolve. The grant then fails, the harden fails closed, and every native request
returns 503.

Both environment variables are also writable by the process that launched us,
which makes the principal attacker-influenceable in a permissions path.

## Change

Prefer the current user's SID. A SID sidesteps the naming question entirely: it
is what the token actually carries, it is identical in domain and workgroup
cases, it survives a computer rename, and icacls accepts `*S-1-5-21-...`
directly as a principal.

**Reuse the existing resolver, do not write a new one.**
`src/codex/user-identity.ts:69-75` already resolves
`[WindowsIdentity]::GetCurrent().User.Value` and validates it against
`SID_PATTERN`. An earlier draft of this plan proposed a fresh `whoami /user`
lookup, which would have been strictly worse: an unqualified `whoami` is
resolvable through `PATH`, so a permissions path would have gained an
executable-substitution surface it does not currently have. Extract the shared
resolver rather than duplicating it, and keep the trusted-executable launch.

Two constraints the extraction must honor:

- **Charge the lookup against the harden deadline.** The 30s envelope from `030`
  is per harden call and a spawn is not free; a lookup outside the budget could
  push a call past it.
- **Cache only success.** A failed lookup must be retried, not memoized into a
  permanent fallback.

### Failure is fail-closed, not a guess

Resolution order is deliberately short:

1. Shared SID resolver -> `*<sid>`.
2. On failure, the existing `USERDOMAIN\USERNAME` form (current behavior).

An earlier draft put bare `USERNAME` ahead of the qualified form. That is wrong
in a security-relevant way: a bare name resolves ambiguously when a local and a
domain account share it, which is the exact authority-confusion class this fix
exists to remove. The grant ACE is installed before inheritance is removed
(`src/lib/windows-secret-acl.ts:459-465`), so a wrong principal is not a
cosmetic error.

On a `required: true` harden, a SID failure should fail closed rather than fall
back at all. The qualified fallback exists only for the optional read path,
where the current behavior is already the status quo.

## What the principal resolves to

| Case | Before | After |
|---|---|---|
| Domain-joined | `CORP\jane` | jane's SID |
| Workgroup | `DESKTOP-A1\jane` (may fail) | jane's SID |
| Microsoft account | `DESKTOP-A1\jane` (profile name may differ from account) | jane's SID |
| Renamed computer | stale `OLDNAME\jane` | jane's SID |

## Security posture

This must not become a way to grant to the WRONG principal. The SID comes from
the effective Windows token (`[WindowsIdentity]::GetCurrent().User.Value`), not
from environment. A malformed or unparseable result is rejected, never coerced.

Net effect on the environment-variable exposure: the SID path does not read
`USERDOMAIN` or `USERNAME` at all, so the common case stops depending on
writable environment state.

## Do not relocate the existing resolver — extract a neutral primitive

`src/codex/user-identity.ts` has the right lookup but the wrong packaging for
this caller, in four specific ways:

1. It throws `CodexUserIdentityRefusal` (`:33-44`), a domain-specific error the
   ACL path has no business catching.
2. It launches an unqualified `powershell.exe` (`:46-60`) — PATH-resolvable, the
   same substitution surface that disqualified the `whoami` idea.
3. It has no timeout and no `windowsHide`.
4. It is synchronous, so reusing it inside `hardenSecretPathAsync`
   (`src/lib/windows-secret-acl.ts:700-748`) would block the event loop and
   defeat the async path.

So the shared piece is a neutral primitive: SID parsing/validation plus bounded
**sync and async** resolvers that launch an absolute System32 PowerShell path.
`user-identity.ts` keeps translating failures into its own refusal type; the ACL
owner applies its own required/optional policy. Cache successful values only.

**Do not write a third System32 resolver.**
`resolveTrustedWindowsPowerShellExe()` in `src/lib/windows-elevation.ts:103-138`
already resolves and validates the executable through `GetSystemDirectoryW`.
Reuse it, or lift its trusted-path machinery into a neutral Windows
system-tools module — a fresh `SystemRoot`/PATH lookup would reintroduce exactly
the substitution surface this whole section exists to close. The SID primitive
still needs its own bounded sync/async execution and neutral error type; only
the executable resolution is shared.

## Timeout must not poison the path memo

A SID lookup that times out has to be classified distinctly. If it surfaces as
an ordinary `ETIMEDOUT`, `hardenEntry` records the path in `timedOutPaths`
(`src/lib/windows-secret-acl.ts:687-690`) and skips it for the rest of the
process — even though no `icacls` operation timed out and the path itself is
fine. Charge the lookup against the shared deadline, but keep its failure out of
that memo.

## Test

`tests/windows-secret-acl.test.ts`, using the existing seams plus an injected
SID resolver:

- `resolves the ACL principal from the token SID, not USERDOMAIN` — resolver
  returns a SID; assert the icacls invocation carries `*S-1-...` and that
  `USERDOMAIN` is never consulted.
- `a malformed SID is rejected rather than passed to icacls` — resolver returns
  garbage; assert no garbage principal reaches icacls.
- `a required harden fails closed when the SID cannot be resolved` — no bare
  username, no guess.
- `an optional harden falls back to the qualified name` — the only place the
  legacy `USERDOMAIN\USERNAME` form survives, and its boundary is explicit.
- `a SID lookup timeout does not mark the path as icacls-timed-out` — assert the
  path is retryable rather than stuck in `timedOutPaths`.
- `only successful lookups are cached` — a failure must not memoize into a
  permanent fallback.
- Both the sync and async harden entry points get coverage; the async one is the
  reason a synchronous spawn is unacceptable.

Note on the memo: `loadConfig` calls three harden wrappers
(`src/config.ts:1759-1764`), but SID resolution only runs on Windows for paths
that exist and are not already memoized, so "runs three times" is an upper
bound rather than the normal case.

Env isolation follows the `previousAclTimeout` pattern already in
`beforeEach`/`afterEach`.

## Security review gate

Same class as `030`: this is credential-permission handling and needs explicit
security review plus `bun run privacy:scan` before the PR leaves draft.
