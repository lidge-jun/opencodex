# 090 — Work-phase 3: pre-dispatch account selection

Doc `080` recorded kiro-lb as ahead on one axis that matters directly to the user's ask:
it picks an account *before* dispatch, while we only reordered the 429 recovery path. This
phase closes that gap. Branch `codex/kiro-pool-predispatch`, off merged `dev` `d82b3049d`.

## What changed

`preferredInitialAccount(config, provider)` answers "which account should open this turn".
The initial OAuth resolution in `src/server/responses/core.ts` consults it and, when it
names an account, resolves that account's snapshot instead of the active one.

It is a **preference, not a gate**. A null answer means "use the active account", and null
is returned for: rotation disabled, fewer than two accounts, no quota evidence anywhere on
the roster, every candidate cooled, or the ranking simply agreeing with the active account.
A provider with no per-account quota therefore behaves exactly as before.

## Five review rounds

An independent reviewer failed this four times before passing. Each finding was real, and
three of them were defects I would not have found by testing the happy path.

### Round 1 — three blockers

1. **Antigravity could pair B's bearer with A's project.** The ordinary path fills the CCA
   project only when it is *empty* (`!route.provider.project`), so a preferred account
   installed its own bearer beside the configured account's project — #2841 in its
   original shape, at a site nobody had reason to look at.
2. **A quota-less provider could still be redirected.** Cooling the active account collapses
   the eligible list to one candidate, and ranking a single candidate returns it unchanged.
   That *looks* like a ranked answer while nothing was ever measured. Evidence is now
   checked across the whole roster, before eligibility narrows anything.
3. **Two uncached credential-file reads per request.** `loadAuthStore` chmods the config
   dir, chmods the secret, and re-parses the whole file on every call — the exact cost the
   neighbouring `PRESENCE_CACHE_TTL_MS` comment exists to warn about.

### Round 2 — the fail-closed 401 was worse than the bug

My first Antigravity fix returned 401 when a preferred account had no project. But
Antigravity tolerates project discovery failing, so a project-less account is an ordinary
stored state: a *preference* had been given the power to break a request that would
otherwise have worked. It now falls back to the active account.

### Round 3 — a removed account became a 401

The roster is cached for two seconds, so an account can be deleted after being chosen.
Resolving it throws, and that throw reached the client as 401 while a healthy active
account sat unused. The reviewer reproduced it exactly. Resolution failures now drop the
stale roster and retry on the active account.

### Round 4 — the one a catch could not catch

The sharpest finding. An account newly flagged `needsReauth` **does not throw**: its
credential is still readable, so resolution succeeds and no error path fires. The request
would dispatch on an account already known to need a fresh login.

My first fix re-read the store to validate the winner — and reopened blocker 3, because the
steady state of this feature is a pool where one account consistently ranks higher, so
"validate only on redirect" is "validate on every request".

### Round 5 — atomic validation, then PASS

The check belongs where the store row is *already* being read.
`getAccountCredentialWithStatus` returns credential and `needsReauth` from one read, and
`requireUsableAccount` makes account-scoped resolution reject an unusable account from
inside it. Selection now performs no store read at all; the caller's existing fallback
handles the rejection. Zero added I/O on the redirect path, both stale classes closed.

## Verification

```text
bun x tsc --noEmit      -> exit 0
bun run privacy:scan    -> Privacy scan passed
bun test (11 files)     -> 181 pass / 0 fail / 656 expect() calls
core-lab-boundary       -> pass, no new src/lab/ reach
```

Tests worth naming, because each encodes a defect above: a redirecting selection with
`auth.json` deleted still answers (proves the cache); a reauth-flagged account resolves
plainly but rejects under `requireUsableAccount` (proves why a catch was insufficient); and
cooling the *active* account of a quota-less provider still returns null.

## Result

The "pre-request selection" row moves out of doc `080`'s "they are ahead" column. Two rows
remain there honestly: kiro-lb persists quota across restart, and it has a real operations
dashboard. Neither is in scope here.
