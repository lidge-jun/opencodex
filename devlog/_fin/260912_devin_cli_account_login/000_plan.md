# Devin CLI as an account provider

**Unit:** 260912_devin_cli_account_login
**Class:** C3 (public provider contract + a documented invariant + GUI surface)
**Goal (host):** register devin-cli as an account provider so it appears in the
dashboard accounts tab beside devin, by giving it a login entry that drives the
installed Devin CLI's own auth flow, without opencodex holding a usable Devin
bearer token.

## Why this unit exists

The dashboard's add-provider dialog has three tabs. Two of them (Free, Paid) are
rendered from the preset catalog; the Accounts tab is not. In
`gui/src/components/provider-catalog/ProviderCatalog.tsx` the preset rows are
drawn only when `tier !== "accounts"`, and the Accounts tab instead renders
`accountRows`, which is built from providers that have a login flow. The
`buckets.accounts` bucket that `bucketPresets` computes is never rendered at
all.

That is why `devin-cli` is reachable only under Free today: `authKind: "local"`
makes `isFreeProvider` true (`gui/src/provider-workspace/catalog.ts`), the same
branch that holds Ollama, vLLM and LM Studio. Reclassifying the tier alone would
remove it from Free and put it in a bucket nothing draws, so it would vanish
from the dialog entirely. The only way into the Accounts tab is to become a
provider with a login.

## The constraint this unit has to move

`src/providers/registry.ts` and `tests/providers/devin-cli-adapter.test.ts`
currently pin the opposite posture:

> The installed CLI carries its own credentials from `devin auth login`, so this
> provider takes no key and the proxy never sees a token for this provider.

That statement is about the **request path**, and it stays true: the adapter
spawns `devin acp` and the child authenticates itself. What changes is the
**dashboard path**, which gains a login entry whose job is to run the CLI's own
auth flow and read back who is signed in. The distinction the unit must keep
explicit, in code comments and in the tests, is:

- the adapter still never reads, requests, or forwards a credential at request time;
- the OAuth entry stores an identity marker, never a usable Devin bearer token.

If those two cannot both hold, the unit stops and reports rather than inventing a
token to satisfy the framework.

## Constraints

- No repository-wide local suite, typecheck, or build. Focused tests only; hosted
  CI on the exact PR head is the gate. Push with `--no-verify`.
- The Devin CLI is **not installed** on the development machine and must not be
  installed as part of this unit without a separate instruction. Every code path
  that depends on the binary needs a documented degraded behaviour and a test
  that exercises it through an injected spawn, the way
  `tests/providers/devin-cli-adapter.test.ts` already drives the adapter.
- `src/lab/` must stay off the core path; nothing here touches `src/router.ts`,
  `src/server/lifecycle.ts`, or `src/server/responses/core.ts`.
- Target branch is `dev`.

## Work-phase map

Dependency-ordered; each is one full PABCD cycle.

| Phase | Doc | Outcome |
|---|---|---|
| wp1 | this unit | Roadmap locked, every later phase written to diff level |
| wp2 | `010_phase1_cli_login.md` | `src/oauth/devin-cli.ts`: signed-in detection, login that drives the CLI, identity-only credential |
| wp3 | `020_phase2_reclassify.md` | Registry + OAUTH_PROVIDERS registration, invariant text, tests that pinned `local` |
| wp4 | `030_phase3_surface_and_land.md` | Accounts-tab proof against the running service, docs/locale, PR, merge |

## Open risks carried into wp2

1. **CLI absent.** Signed-in detection cannot be proven end to end on this
   machine. wp2 must therefore make the binary lookup injectable and prove both
   branches (found / not found) with the existing `resolveDevinCliBinary`
   override seam, and wp4 must state plainly that the live signed-in path is
   unproven here.
2. **No documented status subcommand.** If the CLI exposes no non-interactive way
   to report the signed-in account, the login entry can only report "the CLI
   reports it is signed in" without an identity. That is still enough for an
   accounts row, but it changes the credential shape, so wp2 decides this against
   the subagent finding recorded in `001_cli_auth_survey.md` and amends
   `010_` before building.
3. **Refresh.** The OAuth framework expects a refresh path. `src/oauth/devin.ts`
   throws `invalid_grant` because Cognition mints no refresh token; the CLI entry
   has the same shape and should reuse that posture rather than extending an
   expiry it cannot honour.

