# 040 — wp4: #1215 OpenCodex-scoped noProxy

## The gap

`applyProxyEnv` ([config.ts:3116](../../../src/config.ts)) already does the hard part: it
merges the inherited `NO_PROXY`/`no_proxy` with the loopback hosts, deduplicating
case-insensitively. What it lacks is a way for the operator to add their own entries WITHOUT
setting a machine-wide environment variable.

The reporter's case: internal hosts that must bypass the corporate proxy, on a machine where
`NO_PROXY` is owned by another tool.

## MODIFY map

### `src/types/config.ts` — beside the existing `proxy` field (~line 501)

```ts
/**
 * Hosts that bypass `proxy` for OpenCodex's own outbound provider calls, merged into
 * NO_PROXY at startup. Accepts a comma-separated string (NO_PROXY syntax) or an array.
 * Loopback is always excluded regardless of this setting, and an inherited NO_PROXY is
 * preserved — this ADDS entries, it never replaces the environment.
 */
noProxy?: string | string[];
```

**`string | string[]`, recorded as a deviation (audit B3).** #1215 asks for `string[]`.
The sibling `proxy` field is a `string` and `NO_PROXY` syntax is comma-separated, so an
operator will reach for the string form by muscle memory. Both are accepted and normalized
identically: the array costs one `Array.isArray` branch and removes any ambiguity about
separators appearing inside a value.

### `src/config.ts` — inside `applyProxyEnv`

The merge loop already exists; the change is the source list it walks and one normalization.

Before:

```ts
for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
  if (!seen.has(host)) {
    entries.push(host);
    seen.add(host);
  }
}
```

After:

```ts
// Configured entries first, then loopback: loopback is unconditional, so appending it last
// keeps it present even when the operator lists a loopback host themselves.
const raw = config.noProxy;
const configured = (Array.isArray(raw) ? raw : (resolveEnvValue(raw) ?? "").split(","))
  .map(entry => entry.trim())
  .filter(Boolean);
for (const host of [...configured, "localhost", "127.0.0.1", "::1", "[::1]"]) {
  const key = host.toLowerCase();
  if (!seen.has(key)) {
    entries.push(host);
    seen.add(key);
  }
}
```

**The `toLowerCase()` is audit finding B3.** `seen` is built from lowercased entries
([config.ts:3122](../../../src/config.ts)), but the original draft pushed configured entries
without normalizing — so a configured `LOCALHOST` would have been followed by `localhost`,
failing this phase's own dedupe criterion. The pushed VALUE keeps the operator's casing; only
the lookup key is normalized.

`resolveEnvValue` gives the string form the same `${VAR}` indirection `proxy` already
supports — they are a pair and should not diverge.

**Early-return trap.** `applyProxyEnv` returns immediately when `config.proxy` is unset
(line ~3118). That is correct and stays: `noProxy` without a proxy is meaningless, and
writing `NO_PROXY` for a process that proxies nothing would leak OpenCodex config into
unrelated child processes. Pin it by test rather than leaving it to be "fixed" later.

## TESTS — `tests/proxy-env.test.ts`

| Case | Assertion |
|---|---|
| Configured string reaches `NO_PROXY` | `"internal.example,10.0.0.0/8"` both present |
| Configured array reaches `NO_PROXY` | `["internal.example","10.0.0.0/8"]` equivalent to the string form |
| Loopback survives | all four loopback forms still present |
| Inherited `NO_PROXY` preserved | a pre-set value is merged, not replaced |
| Case-insensitive dedupe | configured `"LOCALHOST"` produces no duplicate (audit B3) |
| `${VAR}` indirection | env-referenced string value resolves |
| No proxy configured | `NO_PROXY` untouched — the early return holds |

## Verification (C)

```bash
bun test tests/proxy-env.test.ts
bun x tsc --noEmit
```

Docs: add `noProxy` to the configuration reference next to `proxy`, showing both forms.

Closes #1215.

