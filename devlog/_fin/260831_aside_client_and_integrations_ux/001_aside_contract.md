# What Aside actually reads

Observed on this machine, 2026-08-31, against Aside CLI `1.26.810.1915` and app
bundle `1.0.825.1`. Every claim below was read off a real file or a live process,
not inferred from documentation.

## Account roots

`~/.aside/accounts.json` (mode 600) carries:

```json
{ "version": ..., "currentAccountId": 0, "accounts": [ { "id": 0, "email": "..." }, { "id": 1 } ], ... }
```

Per-account state lives at `~/.aside/u/<id>/`. Both `u/0` and `u/1` exist here,
so multi-account is not hypothetical. The provider catalog is
`~/.aside/u/<id>/models.json`.

**No environment override exists.** `strings` over the CLI binary yields
`ASIDE_DAEMON_BASE_URL`, `ASIDE_CLI_*`, `ASIDE_MCP_*`, `ASIDE_PRODUCT_VARIANT`,
`ASIDE_RELEASE_BASE_URL`, `ASIDE_NATIVE_HELPER_BINDING` — and nothing that
relocates the account root. The only literal `.aside` path in the binary is
`path.join(os.homedir(), ".aside", "cli", "update-check.json")`.

This makes Aside unlike every existing client. `dshHomeDir` honors `DSH_HOME`;
`mcodeHomeDir` honors `MINIMAX_DATA_DIR` then `MAVIS_DATA_DIR`; `piAgentDir`
honors `PI_CODING_AGENT_DIR`. Aside has no such variable to honor, so the
resolver's variable is the ACCOUNT ID, not a path.

### Decision: read the manifest, fail closed, add no opencodex env var

A resolver that only reads `~/.aside` cannot be tested without writing to the
user's real Aside install. Every existing path helper takes `(env, home)` and
the tests redirect `home`; Aside does the same, so the root is
`join(home, ".aside")` and tests redirect `home` exactly as
`tests/prime-client.test.ts` does.

An earlier draft added `OPENCODEX_ASIDE_ACCOUNT` so a user could target a
non-current account. **Dropped after audit.** This registry's contract is to
honor each client's OWN override (`registry.ts:45`) — `DSH_HOME`,
`MINIMAX_DATA_DIR`, `PI_CODING_AGENT_DIR` all belong to their clients. Aside
ships no such variable, so inventing an opencodex-namespaced one is new product
behavior dressed up as path resolution. Account selection, if it is ever wanted,
is its own unit with its own surface.

We write the account Aside itself reports as current, and nothing else.

**Fail closed rather than fall back.** An earlier draft defaulted to account `0`
when `accounts.json` was missing or unparseable. On this machine both `u/0` and
`u/1` exist, so that fallback could name a real config file belonging to the
WRONG account and then pass the installation gate — a silent write into another
account's catalog. Instead:

- Manifest present with a non-negative integer `currentAccountId`: use it.
- Manifest absent, unreadable, unparseable, or the id malformed: throw
  `ClientPathError`. The surface reports the client as unavailable with a real
  reason, exactly as an unresolvable `DSH_HOME` does today.

A missing manifest means Aside has not established which account is current, and
there is no honest value to guess.

**Resolve both paths from one account read.** `freezeIntegrationInput` called
`configPath` and `detectDir` separately (`writer.ts:621`), and `readIntegrationState`
did the same. Both now depend on file contents rather than only `env` and `home`,
so a manifest rewritten between the two calls could verify one account's install
and then write a different account's catalog.

A cache was the first idea and it does not work: any cache keyed on the manifest
re-reads exactly when the manifest changes, which is the case the consistency is
needed for, and nothing tells a path helper when an operation ends. The audit
caught that contradiction.

The fix is a seam instead. `resolveIntegrationPaths(clientId, env, home)` in the
integration registry returns the PAIR, and an optional `resolvePaths` on a client
spec lets Aside derive both from a single `asideAccountDir` call. Every other
client keeps the default behavior, so the pair stays correct for them without
any of them knowing why the seam exists.

## The provider block

The live `~/.aside/u/0/models.json`, provider keys in their on-disk order with
values elided:

```json
{ "providers": { "opencodex": {
  "baseUrl": "http://127.0.0.1:10100/v1",
  "apiKey": "opencodex-loopback",
  "api": "openai-completions",
  "models": [ { "id": "...", "name": "...", "reasoning": true,
                "thinkingLevelMap": { "off": null, ..., "max": "max" },
                "input": ["text","image"], "contextWindow": 1000000,
                "maxTokens": 32000 } ]
} } }
```

Four provider keys and 24 model entries. `thinkingLevelMap` uses the same seven
pi levels (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`) with `null` for
levels the model does not declare. `input` is `["text","image"]` throughout, or
`["text"]` alone.

### The same key SET, not the same byte order

An earlier draft called this file "byte-identical" to `buildPiClientConfig`
output. That was wrong, and the audit caught it.

The builder emits `baseUrl`, `api`, `apiKey`, `models`
(`config-export.ts:1038`); the hand-written file has `baseUrl`, `apiKey`,
`api`, `models`. Model entries differ the same way — the builder writes `input`
before the optional reasoning fields, the live file after. `serializeDocument`
preserves insertion order, so the emitted bytes really do differ.

The true claim is weaker and sufficient: **the same four provider keys, the same
dialect string, the same placeholder, and the same model field vocabulary.** JSON
key order is not semantic and Aside parses this file rather than diffing it. What
the builder produces is a document Aside accepts; it is not the document a human
happened to type.

So this unit claims compatibility, not equality. The test backing it must NOT be
`buildAside(ctx) === buildPi(ctx)`: both call the same function, so that
assertion is tautological. wp2 asserts against a fixture captured from the
observed Aside shape — same key set, same dialect, placeholder rather than a
credential, model fields drawn from the observed vocabulary.

## Reuse, and the one thing not to reuse

`prime` set the precedent: it reuses `buildPiClientConfig` and `summarizePi`
verbatim and adds only `buildPrimeContribution`, so ownership records carry
`clientId: "prime"`. Aside follows that exactly. Restating the shape would
create a second copy of one fact, which is the bug that comment warns about.

## loopbackOnly: true

The provider block has four keys and none of them is `headers`. A dedicated
`x-opencodex-api-key` header has nowhere to live, so a non-loopback bind would
generate a config that 401s. Same reasoning, same verdict as `dsh`, `kimi`,
`gajae`, `mcode`, and `zcode`.

`apiKeyEnv` is therefore `""` and `exportHint` says loopback needs no key.

## Hazard: Aside overwrites the file while running

The Aside skill reference states that editing `models.json` while Aside is
running risks the daemon overwriting it, and `Aside Daemon` was live during
this investigation. The pattern for this already exists: Claude Desktop's copy
says "Fully quit and reopen it for this change to take effect"
(`integrations.dialog.desktop.restart`). Aside gets the same treatment in its
`integrations.semantics.aside` string.

This is a copy problem, not a writer problem. The writer already snapshots
before every mutation and journals what it did, so an overwrite by Aside is
recoverable the same way any drift is.

## Not in scope

`~/.aside/u/0/models.json` can hold a plaintext key for a user's OWN providers,
and `credentials.json` certainly does. We write one fragment,
`providers.opencodex`, and the merge layer touches nothing else. No Aside
credential is ever read, printed, or serialized.
