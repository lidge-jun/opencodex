# Audit round 1 — four independent agents on grok-4.6

Dispatched from P with read-only packets (DISPATCH-TASK-01), each required to
anchor every finding with `path:line` and a verbatim quote.

| Agent | Lens | Verdict |
|-------|------|---------|
| `01a08fc7-0e6f` | execution correctness (argv, exit codes, ordering, bypass) | PASS, no findings |
| `01a08fc7-0fa9` | security and boundary | PASS, 1 minor |
| `01a08fc7-10fd` | repository conventions and test quality | PASS-WITH-FIXES, 2 major + 3 minor |
| `01a08fc6-352e` | architect reflection on the written plan | MISALIGNED (read a pre-docs snapshot), 5 gaps |

Synthesis verdict: **near-pass / GO-WITH-FIXES**. No blocker. Eight findings
folded, one rebutted.

## Folded

1. **Secret echo on the newly reachable parser** (security, minor).
   `src/cli/account-auth.ts` called `rejectArgs(args, USAGE)` with no
   redaction, so an authorization code pasted as a bare positional was echoed
   in `Unexpected argument(s): …`. That parser is now one word away from
   `ocx login`, so it takes `{ redactValues: true }` — flag-shaped leftovers
   still print, because a mistyped flag is what the message has to name.
2. **The "flags survive" test could not fail** (test quality, major).
   Dropping the flags at the dispatch seam leaves an empty leftover list, so
   `rejectArgs` stays quiet and the liveness probe prints the same message the
   test asserted. Replaced with a case that answers the probe with a live proxy,
   stubs `fetch`, and reads the `/api/codex-auth/login` POST body. Proven red
   by passing only `loginArgs[0]`.
3. **Docs not in the commit** (conventions, major). They existed in the working
   tree when the architect read the committed snapshot; they are in this unit's
   commit now, across English, seven locales, and both CLI reference pages.
4. **The wall was asserted in isolation** (minor). A case now spies
   `process.exit` and asserts what `handleLogin` actually prints.
5. **Nothing proved a non-Codex name stays off the account path** (minor). The
   same case asserts the wall appears and `Proxy is not running` does not, so a
   regression routing every name through the account command fails here.
6. **No content assertion on the discoverability text** (minor). The registry
   `details` for `login` are asserted directly.
7. **No guard against a future key-provider id collision** (architect, minor).
   `isKeyLoginProvider` is now asserted false for all three spellings and true
   for `openai-apikey`.
8. **`ocx login openai` lost its only pointer to `openai-apikey`** (architect,
   minor). Routing `openai` means that user no longer sees the list that named
   the platform-key provider, so the wall and the registry details name it.
   The `?? 1` coalesce is also explained in place rather than left looking dead.

## Rebutted

**The `account-auth` import is unconditional on the `login` path.** Kept.
Both the architect and the execution reviewer independently judged the cost
acceptable: one CLI module load on a user-typed browser-login command, acyclic,
no import-time IO, and none of the three files `AGENTS.md` protects
(`src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`) is
on the path. Splitting the predicate into its own module to save it would
contradict the single-source-of-truth decision for a cost that cannot be
measured at a login prompt.

## Explicitly cleared by review

- `/api/codex-auth` behavior, token storage and refresh: unchanged.
- The `chatgpt` exclusion from the generic public OAuth surface: still closed.
  The routed call never reaches `/api/oauth/login`; `isPublicOAuthProvider` and
  `listOAuthProviders` are untouched.
- Name collisions: `openai` is `authKind: "forward"` in the provider registry
  and was never a key login; the key id is `openai-apikey`. There is no
  registry id `codex` or `chatgpt`.
- `handleLogin` has no second caller, and the `login` registry entry declares
  no alias that could reach the runner by another name.
- Test placement needs no `layout.json` change: the cases were added to an
  existing mapped file.

The security reviewer also recorded that this diff sits on the `ocx login`
authentication entrypoint and therefore falls under the `AGENTS.md` security
review requirement, and that its review is that review — token storage, OAuth
internals and the Codex auth routes are not modified by it.

