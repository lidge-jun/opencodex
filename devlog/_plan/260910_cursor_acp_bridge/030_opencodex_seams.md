---
title: What OpenCodex requires of a spawning provider
unit: 260910_cursor_acp_bridge
phase: 3 of 4
date: 2026-09-10
---

# 030 -- OpenCodex adapter seams

Read bound: this repository at `58acdaeb7`.

## The adapter contract

`ProviderAdapter` (`src/adapters/base.ts:24-79`) supports two transports:

```ts
export interface ProviderAdapter {
  name: string;
  buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): AdapterRequest | Promise<AdapterRequest>;
  fetchResponse?(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response>;
  parseStream(response: Response, budget: TranslatorBudget, tierMetadata?: AdapterTierMetadata): AsyncGenerator<AdapterEvent>;
  runTurn?(parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void): Promise<void>;
  // ...
}
```

HTTP providers go `buildRequest` -> fetch -> `parseStream`. Anything else
implements `runTurn` and stubs the other two. The Responses core branches on the
presence of `runTurn` at `src/server/responses/core.ts:6625-6675` and pushes
emitted events into `createAdapterEventQueue`.

Input is `OcxParsedRequest` (`src/types/request.ts:42-133`): `modelId`,
`context` (`messages`, optional `systemPrompt` and `tools`), `stream`,
`options`. Output is the `AdapterEvent` union, which begins at
`src/types/request.ts:310` and runs past 365: `text_delta`, `thinking_delta`,
`tool_call_start|delta|end`, `done` (`:335`), `incomplete` (`:344`) and
`error` (`:355`), with `OcxUsage` on `done`/`error`. (An earlier draft cited
`310-354`, which stopped short of the `error` member; corrected after audit.)

Worth noting for anyone tracing this: `src/router.ts` never constructs an
adapter. It selects provider and model only. Construction is
`createRegisteredAdapter` (`src/adapters/registry.ts:159-164`) reached through
`resolveAdapter` (`src/server/adapter-resolve.ts:50-52`).

So `runTurn` is a real, supported, in-tree seam for a provider that is not an
HTTP endpoint. The transport question is settled before it is asked.

## The precedent, and the condition that makes it work

`src/adapters/coding-agent/` is a shared transport for official vendor CLIs,
currently CodeBuddy and Qoder. Family adapters supply only profile, args and env.

A profile (`coding-agent/profile.ts:14-32`) pins `providerId`, `family`,
`region`, `canonicalBaseUrl`, `binaryCandidates`, `tokenEnv` and
`installHint`. A non-canonical `baseUrl` fails closed
(`profile.ts:86-99`, `turn.ts:104-117`) so a region-scoped credential cannot be
handed to an unexpected destination.

`runCodingAgentTurn` is documented at `turn.ts:81-86` as "one headless
coding-agent CLI turn as an OpenCodex `runTurn`". The operational parts sit
lower in the file than an earlier draft claimed, and are cited precisely here
after audit: the `spawnFn` call is `turn.ts:147-152`; the scoped env allow-list
is `turn.ts:27-47`; projected JSONL is written to stdin and JSON lines are read
from stdout at `turn.ts:243-258`; stderr is bounded and redacted around
`turn.ts:194-222`. It uses `node:child_process`, not `Bun.spawn`.
`protocol.ts` parses Anthropic/Claude-Code `stream-json` as a pure module that
never spawns and never touches the network, which is what makes it
fixture-testable.

The family adapter shape is minimal:

```ts
buildRequest(): AdapterRequest { return { url: provider.baseUrl, method: "POST", headers: {}, body: "" }; }
async *parseStream(): AsyncGenerator<AdapterEvent> {
  yield { type: "error", message: "CodeBuddy adapter uses runTurn; the fetch/parseStream path is disabled." };
}
async runTurn(parsed, incoming, emit) { await runCodingAgentTurn({ /* ... */ }); }
```

**Now the condition.** CodeBuddy is launched as:

```
-p --output-format stream-json --tools "" --max-turns 1 --no-session-persistence
```

(`src/adapters/codebuddy/adapter.ts:37-49`), and `turn.ts:83-86` states the
reason plainly: **"Codex retains tool ownership."**

`--tools ""` empties the vendor's tool set. `--max-turns 1` stops it from
looping. `--no-session-persistence` denies it memory across turns. The vendor
CLI is deliberately reduced from an agent to a model endpoint, and only then does
it fit `ProviderAdapter`. The class even has a name in the test suite:
`TOOL_LESS_ADAPTERS` (`tests/adapters/adapter-tool-conformance.test.ts:422`).

That reduction is the load-bearing part of the precedent, not the spawning.

## Registration touchpoints

What a new spawn provider must actually touch:

| Seam | Proof |
|---|---|
| Adapter factory + `AdapterWire` | `src/adapters/registry.ts:58-122`, `:23-32` |
| Registry authority test | `tests/adapters/adapter-registry-authority.test.ts:12-25,70-71` |
| Provider preset | `src/providers/registry.ts` (ids `codebuddy`/`qoder` at `:3191-3280`) |
| Model catalog | `src/providers/codebuddy-models.ts:1`, `src/providers/qoder-models.ts:1` -- whole-file model tables, cited at file head because no single interior line is the seam |
| Config seed | `src/providers/derive.ts:218-228` |
| GUI labels/icons | `gui/src/provider-icons.ts:52-53,154-157` |
| Live model discovery | `src/adapters/qoder/live-models.ts:66-70`, `src/codex/catalog/provider-fetch.ts:1606` |
| Docs | `docs-site/src/content/docs/guides/providers.md:664-723`; adapter enum at `docs-site/src/content/docs/reference/configuration/providers.md:128` |
| Tests | `tests/providers/provider-registry-parity.test.ts:41`, `tests/adapters/adapter-tool-conformance.test.ts:422`, `tests/helpers/adapter-conformance/wire-drivers.ts:321-327` |
| Test layout registration | `scripts/test-layout/layout.json:375-376,992-993` |
| Profile family union | `coding-agent/profile.ts:16` -- a new family must extend it or fork |

One constraint that would bite an implementer: a per-model wire override
**cannot** name a coding-agent adapter. `MODEL_ADAPTER_OVERRIDE_ALLOWED` is only
`openai-chat` and `openai-responses` (`src/types/wire.ts:38-41`).

## Hard constraints

- Bun-native TypeScript, but the established spawn path uses `node:child_process`
  with Windows handling through `commandInvocation` (`src/lib/win-exec.ts:80-84`).
  Child spawning by an adapter is allowed and already done.
- The Lab boundary names `src/router.ts`, `src/server/lifecycle.ts` and
  `src/server/responses/core.ts` (`AGENTS.md`,
  `tests/lab/core-lab-boundary.test.ts:20-29`); the guarded list also includes
  `management-api.ts`. Adapters are not on that protected list, and must not
  import Lab either.
- `startServer` stays synchronous up to `labActivationRequired`. Adapter spawn
  is per-turn, so it does not interact with that window.
- `runTurn` skips the web-search sidecar
  (`src/server/responses/core.ts:6311-6323`).
- The current coding-agent v1 is text and reasoning only; tools and MCP are off,
  and the canonical URL is treated as a credential boundary.

## The one that is already there, and what it cost

OpenCodex already ships a Cursor provider over HTTP: `src/adapters/cursor/`.
Measured 2026-09-10:

| | files | lines |
|---|---:|---:|
| `src/adapters/cursor/` | 43 | 13,918 |
| `src/adapters/coding-agent/` | 3 | 916 |

Fifteen times the size. That ratio is not incidental complexity, and reading what
the bulk of it does changes the analysis in 040.

**Cursor's HTTP backend also drives client-side execution.** The Private
Inference protocol has the server ask the client to run things, and OpenCodex has
to answer. That is what the `native-exec` family is:

| lines | file |
|---:|---|
| 748 | `native-exec.ts` |
| 550 | `native-exec-shell.ts` |
| 332 | `native-exec-fs.ts` |
| 194 | `native-exec-desktop.ts` |
| 153 | `native-exec-mcp.ts` |
| 118 | `native-exec-tools.ts` |
| 76 | `native-exec-common.ts` |
| 43 | `native-exec-network.ts` |

The exported refusal surface names the scope directly:
`rejectReadExecForPolicy` (`native-exec-fs.ts:52`),
`rejectWriteExecForApplyPatch` (`:90`), `rejectWriteExecForPolicy` (`:101`),
`rejectDeleteExecForApplyPatch` (`:139`), `rejectDeleteExecForPolicy` (`:150`),
`rejectLsExecForPolicy` (`:191`), `rejectGrepExecForPolicy` (`:259`),
`rejectShellExecForPolicy` (`native-exec-shell.ts:119`),
`rejectShellStreamExecForPolicy` (`:160`),
`rejectBackgroundShellSpawnExecForPolicy` (`:266`),
`rejectWriteShellStdinExecForPolicy` (`:523`),
`rejectFetchExecForPolicy` (`native-exec-network.ts:12`).

A further 877 lines translate between the two tool vocabularies:
`tool-schemas.ts` (254), `tool-naming.ts` (252) mapping Codex `exec_command` /
`apply_patch` / `shell_command` onto Cursor `edit_file` / `multi_edit`,
`tool-guidance.ts` (236), and `tool-result-normalize.ts` (135).

**And OpenCodex did not fully win that fight.** `exec-policy.ts` defaults the
whole capability off:

```ts
export type CursorNativeExecMode = "off" | "codex-sandbox" | "on";
```

> Config-owner-selected policy; explicit mode wins, legacy boolean maps to "on".
> The UNSET default is "off". `nativeLocalExec: "on"` is the only non-legacy
> setting that authorizes Cursor server-driven local read/write/delete/ls/grep/
> shell/fetch execution.
> `nativeLocalExec: "codex-sandbox"` is kept as a recognized legacy/deprecated
> spelling but is fail-closed: opencodex has no trustworthy per-request
> attestation that caller-supplied Responses instructions/system/developer prose
> reflects a real Codex sandbox state.

That comment is an admission worth reading carefully. The invariant OpenCodex
actually maintains is not only "Codex retains tool ownership" -- it is
**"OpenCodex does not execute what it cannot attest."** Unable to verify a
caller's sandbox claim, it refuses rather than guesses.

So the honest framing for 040 is not "HTTP is clean and ACP is dirty". Cursor is
an agent on both transports. On HTTP, OpenCodex spent ~13.9k lines pulling that
agent-ness inside where it could be typed, gated and defaulted off. Any ACP
proposal is therefore not "add Cursor to OpenCodex" but "add a second,
differently-shaped route to a vendor that is already integrated at considerable
cost", and it must justify itself against that.

## Unverified

- Whether a non-`stream-json` CLI should extend `family` or fork the transport
  outright was not decided by this lane.
- `authKind: "local"` exists (`src/providers/registry.ts:40`) but coding-agent
  providers use `"key"`; which is correct for a binary-only agent is open.
- Non-English locale docs under `docs-site/` were not enumerated.
