# wp2 — Aside export client and integration registry

Backend only. No GUI file changes; wp3 owns those. Contract read in 001,
checklist in 002.

## src/clients/config-export.ts

**Path helpers**, placed beside `dshHomeDir`/`mcodeHomeDir`:

```ts
/** Aside's per-account state root. */
export function asideHomeDir(env = process.env, home = homedir()): string {
  return join(home, ".aside");
}

/**
 * The account Aside reports as current.
 *
 * Unlike every other client here, Aside has no path override to honor: its CLI
 * carries ASIDE_DAEMON_BASE_URL and friends but nothing that moves the account
 * root. So the variable is the ACCOUNT, and Aside's own manifest is the only
 * authority on it. We add no opencodex-namespaced override: this registry
 * mirrors each client's variables and does not invent new ones.
 *
 * Throws when the manifest cannot answer. Defaulting to 0 would be a guess, and
 * on a machine with u/0 and u/1 that guess writes into the wrong account's
 * catalog while still passing the installed check.
 */
function asideCurrentAccountId(home: string): number

export function asideAccountDir(env = process.env, home = homedir()): string
  // join(asideHomeDir(env, home), "u", String(asideCurrentAccountId(home)))

export function asideConfigPath(env = process.env, home = homedir()): string
  // join(asideAccountDir(env, home), "models.json")
```

`asideCurrentAccountId` reads `<root>/accounts.json` and returns
`currentAccountId` when it is a non-negative integer. A missing, unreadable, or
unparseable manifest, or a malformed id, throws `ClientPathError` naming the
manifest. That is the same failure shape `absoluteClientPath` uses for a bad
`DSH_HOME`, and the surfaces already render it as an unavailable client.

**One account read per operation, via a registry seam.** `freezeIntegrationInput`
resolved `configPath` and `detectDir` in two separate calls (`writer.ts:621`),
and `readIntegrationState` did the same (`state.ts:385`). These resolvers read a
mutable file, so a switch between the calls could verify one account and write
another.

Memoization was the first proposal and the audit rejected it correctly: a cache
invalidated by the manifest's mtime re-reads precisely when the manifest changes,
and a path helper has no way to know when an operation ends.

So the pair becomes one call. `IntegrationClientSpec` gains an optional
`resolvePaths`, `resolveIntegrationPaths(clientId, env, home)` is the only place
that turns an id into both paths, and Aside implements `resolvePaths` by calling
`asideAccountDir` once and joining `models.json` onto it. Both writer and state
call the seam; every other client falls through to the previous behavior.

Reading a file inside a path helper is not new: this module already calls
`existsSync` at four resolution sites (lines 236, 335, 337, 380). Parsing
contents rather than probing existence is the new part, which is why the failure
is explicit and the result is memoized.

**Contribution builder**, beside `buildPrimeContribution`:

```ts
function buildAsideContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildPiClientConfig(ctx);
  return singleFragment("aside", ["providers", OPENCODE_PROVIDER_ID], doc.providers[OPENCODE_PROVIDER_ID]);
}
```

A comment records WHY the Pi builder is reused: the live
`~/.aside/u/0/models.json` on the machine this was developed on already carried
a hand-written `providers.opencodex` block whose four keys, dialect,
`opencodex-loopback` placeholder, and `thinkingLevelMap` levels match
`buildPiClientConfig` exactly. Same argument prime's comment makes, with live
evidence instead of a package manifest.

**`ExportClientId`**: add `| "aside"`.

**`EXPORT_CLIENTS.aside`**, after `prime`:

```ts
aside: {
  id: "aside",
  filename: "aside-models.json",
  destination: env => asideConfigPath(env),
  apiKeyEnv: "",
  exportHint: "Aside reads a non-secret placeholder from models.json; loopback needs no key.",
  build: buildPiClientConfig,
  format: "json",
  summarize: summarizePi,
  buildContribution: buildAsideContribution,
  loopbackOnly: true,
},
```

`loopbackOnly: true` because the provider block has exactly four keys and none
is `headers`, so the dedicated admission header has nowhere to live. The comment
says that rather than restating the general rule.

`filename` is `aside-models.json` and not `models.json`: the download name is
what lands in a user's Downloads folder, where a bare `models.json` collides
with pi's and prime's. Prime set this precedent with `prime-models.json`.

## src/integrations/registry.ts

Import `asideConfigPath` and `asideAccountDir`; add:

```ts
aside: {
  id: "aside",
  configPath: (env = process.env, home = homedir()) => asideConfigPath(env, home),
  // The ACCOUNT directory, not ~/.aside: the CLI creates ~/.aside/cli for its
  // own update check before any account exists, so the outer directory can be
  // present on a machine that never signed in.
  detectDir: (env = process.env, home = homedir()) => asideAccountDir(env, home),
},
```

No `sourcePreservingYaml` (JSON) and no `writerLock`, same as `pi`/`prime`.

## src/cli/registry.ts

Add `aside` to the `export` command's `usage` and `summary` client union.
Acceptance is already dynamic through `EXPORT_CLIENT_IDS`.

## tests/aside-client.test.ts (new)

Modeled on `tests/prime-client.test.ts`, which locks seven properties. Aside's
cases:

1. The generated document matches a FIXTURE captured from the observed Aside file
   shape: four provider keys, `api: "openai-completions"`, the loopback
   placeholder, and model fields from the observed vocabulary. Deliberately NOT
   an equality check against `buildPiClientConfig`, which would be tautological
   since Aside calls it. See 001 for why key order differs and why that is fine.
2. The owned document is `providers.opencodex` with `baseUrl`, `api:
   "openai-completions"`, `apiKey: "opencodex-loopback"`, `models`.
3. Serialized JSON round-trips and contains no credential.
4. Contribution path is `["providers", "opencodex"]` with `clientId: "aside"`.
5. `currentAccountId: 0` resolves `<home>/.aside/u/0/models.json`, and
   `currentAccountId: 1` resolves `u/1`.
6. Absent, unreadable, unparseable, and malformed-id manifests each throw
   `ClientPathError` — all four asserted, because the point is that none of them
   silently picks an account.
7. `resolveIntegrationPaths("aside")` returns a config path that is the detect
   directory plus `models.json`, so the two cannot name different accounts; a real
   switch moves both together. A pure-path client still resolves through the
   same seam.
8. `detectDir` is the account directory, so `~/.aside/cli` alone is not
   "installed".
9. `loopbackOnly` is true and `apiKeyEnv` is empty.

## Existing tests to update

`client-config-export.test.ts` (ordered ids), `client-config-export-new-clients
.test.ts` (loopback-only set), `integrations-invariants.test.ts` (count plus an
`aside` `SEED` in real JSON shape with a user-owned sibling provider that must
survive), `integrations-state.test.ts` (loopback-only set).

## Verification

`bun test tests/aside-client.test.ts tests/client-config-export.test.ts
tests/client-config-export-new-clients.test.ts tests/integrations-invariants.test.ts
tests/integrations-state.test.ts` plus `bun run typecheck`.
