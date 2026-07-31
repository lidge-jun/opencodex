# 020 — WP2: land PR #464 (warn when routing discards a configured `baseUrl`)

Author: snowyukitty. Head: `fix/router-warn-discarded-baseurl`. Size: +339/-2.
State at inventory: `MERGEABLE/CLEAN` — the only open PR with a clean merge state.

## Problem

Routing resolves a provider's endpoint from the registry before any adapter runs,
so for most built-in providers a `baseUrl` in the user's config is silently
ignored. The user sees traffic going somewhere they did not configure and gets no
signal explaining why. The failure is quiet, which is what makes it expensive.

## MODIFY map

### `src/router.ts`

New import:

```ts
import { redactSecretString, redactUrlForLog } from "./lib/redact";
```

New helper, matching `matchBaseUrlChoice` normalization:

```ts
/** Same endpoint modulo surrounding space and trailing slashes. */
function isSameEndpoint(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
}
```

Plus an origin-only formatter and the warning emission when the resolved endpoint
differs from the configured one.

**The privacy reasoning is the reviewable part of this PR, and it is correct.**
The author logs `URL.origin` and withholds the path, on the grounds that a
configured `baseUrl` path can itself be the credential — an account-scoped route
token like `https://proxy.example/v1/8fK2mP7qR4nV6x` is opaque and high-entropy,
so it matches none of the prefix patterns in `redactSecretString`. Pattern
redaction cannot be trusted for that value, so no path segment is logged at all;
`…/…` marks that a path existed without revealing it. `URL.origin` also excludes
userinfo, query and fragment.

This reasoning is why the PR sits in category A despite touching a log line: it
strengthens the privacy posture rather than risking it, and it stays inside the
`AGENTS.md` constraint against logging credentials.

### Docs

`docs-site/src/content/docs/reference/configuration.md` and its `zh-cn`
counterpart gain a "Fixed provider endpoints" section explaining which providers
honour a configured `baseUrl` (explicit opt-ins, template endpoints, user-defined
providers) and what the new warning means.

## TESTS

`tests/router-discarded-baseurl-warning.test.ts` (NEW) — the warning fires when
the registry endpoint wins, stays silent when the configured URL is honoured, and
the emitted text carries no path segment.

## Integration method

Apply `gh pr diff 464` on `dev` with the author's `Co-authored-by` trailer.
`MERGEABLE/CLEAN` means no conflict is expected.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/router-discarded-baseurl-warning.test.ts tests/router.test.ts` | pass |
| `bun run privacy:scan` | passes — this phase adds a log line, so the scan is load-bearing here |
| `bun run typecheck` | exit 0 |
