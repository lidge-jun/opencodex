# 260912 — Retire the Devin ACP adapter and give Devin the tool-catalog nudge

## Why this unit exists

Two Devin provider rows exist, `devin` and `devin-cli`, and both stream Cognition's
`ApiServerService/GetChatMessage` over Connect-RPC on the `devin` adapter. They differ only in
where the credential came from: a browser sign-in through `RegisterUser`, or the
`devin-session-token` the installed CLI already wrote to its own `credentials.toml`.

A second adapter registered under the id `devin-cli` still existed. It spawned `devin acp` and
drove the child over Agent Client Protocol on stdio. It was unreachable under the `devin-cli`
provider id — `routedProviderConfig` pins the adapter from the registry for any registry id — and
reachable only through a custom-named row such as `"devin-acp"`. Nobody was routed to it.

It is being removed rather than kept, because the premise that justified it turned out to be
false. The design assumed OpenCodex could not hold a credential for the installed CLI, so a child
process was the only way to use it. The CLI's `windsurf_api_key` is an ordinary
`devin-session-token$<JWT>`, the same credential the cloud client already speaks. Importing the
token does everything the child did, without a placeholder `buildRequest`, a disabled
`parseStream`, an identity-only `baseUrl` that no request may connect to, and a subprocess
running in the operator's own tree.

The nudge is the second half. Every non-OpenAI adapter that advertises a client tool catalog
injects `buildNonOpenAIToolCatalogNudgeForTools` into its system prompt — Anthropic, Google,
non-OpenAI `openai-chat` hosts, Kiro, Command Code. The Devin adapter does advertise a real
catalog (proto field #10 via `mapOcxToolsToDevin`) and was the only one left without the
paragraph. Adding it in `mapOcxMessagesToDevin` covers both provider rows at once, because they
share the adapter. The retired ACP wire could never have used it: `session/prompt` carries prompt
text only, with `capabilities: {}` and `mcpServers: []`, so a catalog nudge there would have
described a contract that does not exist on that wire.

## Work phases

### wp1 — land PR #4411

Unrelated in subject, but it is the open PR blocking this branch's base from being clean. Its
`test 3/4`, `gates` and `macos 2/2` failures were one cause: `privacy:scan` flagged a maintainer
email address quoted inside a carried devlog record. The address was incidental to the note.

Done when: exact-head CI is green and the PR is merged into `dev`.

### wp2 — retire ACP, migrate, nudge

Removals:

- `src/adapters/devin-cli/{acp,adapter,binary,models}.ts`
- `tests/providers/devin-cli-adapter.test.ts`, and its rows in `scripts/test-layout/layout.json`
  and `tests/fixtures/test-layout-expected.json`
- the `devin-cli` import, `AdapterWire` member and registry entry in `src/adapters/registry.ts`
- the `devin-cli` case in `upstreamProtocolForAdapter`
- the `devin-cli` row in the adapter-registry authority map, and the wire from
  `RUN_TURN_ONLY_WIRES`

Migration. `projectDevinCliAuthMode` previously warned and changed nothing when a saved row still
named the ACP adapter, on the reasoning that routing already pinned the transport. That reasoning
held only for the registry id. With the adapter gone, a custom-named row has nothing pinning it
and would throw `Unknown adapter: devin-cli` on every request, so the migration now rewrites
**every** row naming the retired id, whatever the row is called. A row still carrying the
identity-only `cli.devin.ai` host is repointed at the api-server in the same pass, because that
URL was never a destination and leaving it would trade an unconstructible adapter for an
unresolvable host.

Nudge. `mapOcxMessagesToDevin` appends the shared paragraph to the system content. The wire name
callback is `tool => tool.name`, not the default namespaced form, because `mapOcxToolsToDevin`
writes the bare name; a nudge listing names the model is never offered is worse than none.

Done when: no adapter id `devin-cli` remains anywhere, saved rows migrate with regression
coverage, the nudge is covered by a regression test, structure/ and docs-site agree, exact-head CI
is green and the PR is merged.

## Verification policy for this unit

Local product suite runs are prohibited by the maintainer. Local checks are limited to
`bun run structure:check`, `bun run privacy:scan`, and explicitly named focused test files.
Everything else is hosted exact-head CI. Skipped local checks are labelled NOT RUN in the PR.

