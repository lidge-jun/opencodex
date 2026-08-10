# 030 — Phase 3: external client adoption research

Independent of `010`/`020`: it touches no runtime file. Recorded here because the
question arrived with the same request and its answer changes what a future
export-client phase would build.

**Read-only unit.** Nothing was committed, pushed, or opened against either
external repository, and nothing in this document authorizes that.

Two subagents ran in parallel: one reading source directly (clones into scratch,
later trashed), one covering the public web. Where they disagree, the source
reading wins and the disagreement is recorded rather than smoothed over.

Snapshot: 2026-08-02 KST.

## 1. Correction to the brief's premise

The request described `oh-my-openagent` as "pi 기반". That is close but not
exact, and the difference is the whole integration answer.

- OMO is a multi-harness agent layer. Its Ultimate edition is an **OpenCode
  plugin**; a Light edition is a Codex plugin.
- Its Pi-shaped surface is the `omo-senpi` package, which depends on
  `@code-yeongyu/senpi@2026.7.26` — Senpi being the same author's fork of Pi
  (`badlogic/pi-mono`, now `earendil-works/pi`).
- Senpi renames Pi's config directory. Its `package.json` carries
  `piConfig: { name: "senpi", configDir: ".senpi" }`, which relocates provider
  config from `~/.pi/agent/models.json` to `~/.senpi/agent/models.json`, with
  `SENPI_CODING_AGENT_DIR` as an override.
- OMO's own `omo.jsonc` selects *which model* an agent uses. It does **not**
  define provider endpoints. The provider layer belongs to Senpi.

So the integration target is not "OMO" at all. It is Senpi, and OMO rides on it.

There is also **no `main` branch** in that repository — `dev` is the default,
1,185 commits ahead of `master`, with 152 branches live. The brief's instinct to
look past `main` was right for a reason it did not expect.

## 2. Gajae Code — already integrated, from their side

The most consequential finding in this unit, and the one that changes what
opencodex should do next:

**Gajae Code merged a read-only OpenCodex provider on 2026-08-01** — PR #3698,
describing local endpoint discovery, port `10100`, `/api/models`,
`opencodex/<id>` selectors, and Responses streaming.

They came to us. Nothing needs to be built for a Gajae user to reach the proxy;
the remaining opencodex-side question is only whether we also ship an *exporter*
so a user can materialize a config file rather than rely on discovery.

### Configuration facts

| Fact | Value |
|------|-------|
| Config file | `~/.gjc/agent/models.yml` (YAML; a legacy `models.json` is migrated when YAML is absent) |
| Provider fields | `baseUrl`, `apiKey`, `apiKeyEnv`, `api`, `headers`, `authHeader`, `auth`, `models` |
| Dialects | `openai-completions`, `openai-responses`, `anthropic-messages`, plus Google/Bedrock/Ollama |
| Key resolution | `apiKeyEnv` reads `Bun.env[name]` strictly; `apiKey` checks env-name-then-literal |
| Arbitrary base URL | Supported and documented, including a custom-proxy example |

### The blocker is ours, not theirs

`ocx export` unconditionally serializes with `JSON.stringify`
(`src/cli/export-command.ts`), but Gajae's canonical destination is **YAML**. A
Gajae exporter would therefore need `ExportClientSpec` to grow a serialization
step — the first structural change to the export core since it landed.

`buildPiClientConfig` is **not** reusable here: Gajae uses `apiKeyEnv` + `auth`,
not Pi's `apiKey: "$VAR"` contract, and the file is YAML.

**Verdict: moderate.** First change would be a `format`/`serialize` facility on
`ExportClientSpec`, then a `gajae-code` builder emitting a YAML provider block to
`~/.gjc/agent/models.yml` with `apiKeyEnv: OPENCODEX_API_KEY` and
`api: openai-completions`. No `modelBindings` — that would overwrite the user's
own role and default choices.

## 3. Senpi (the OMO path) — trivial, and measured

The source agent did not stop at schema reading. It generated a real opencodex Pi
export document and ran it through Senpi 2026.7.26's own runtime schema
validator:

```
SENPI_SCHEMA_VALID=true
```

That is the difference between "the shapes look compatible" and "their validator
accepted our bytes once". The scratch tree that produced it was deleted, so the
result is unarchived — see §Validator artifact before treating it as settled.

So the honest answer to "does the existing `pi` exporter already work
unchanged?" is split:

- **The bytes: yes, on one unarchived measurement.** `buildPiClientConfig` output
  was accepted by Senpi's own validator. Strong indication, not a checked-in
  fact.
- **The exporter as a user-facing operation: no.** `destination` points at
  `~/.pi/agent/models.json`, and Senpi reads `~/.senpi/agent/models.json`. A user
  following our GUI's own destination line puts the file in the wrong place.

Since the GUI renders `destination` from the envelope, this is exactly the field
`010`'s row surfaces on its second line — a wrong path there is a wrong
instruction, which is why it is worth stating in this unit.

**Verdict: trivial.** Add a `senpi` client id reusing `buildPiClientConfig`
byte-for-byte, changing only `filename` and `destination`
(`$SENPI_CODING_AGENT_DIR/models.json`, else `~/.senpi/agent/models.json`). Do
**not** write into `omo.jsonc`; it selects models and does not own endpoints. For
OMO's Ultimate (OpenCode) edition, our existing `opencode` exporter already does
the job.

One nested-selector detail worth keeping: OMO's parser splits on the first slash
only, so `opencodex/anthropic/claude-…` resolves to provider `opencodex`, model
`anthropic/claude-…`. Our namespaced ids survive intact.

## 4. Where the two agents disagreed

| Claim | Web agent | Source agent | Resolution |
|-------|-----------|--------------|------------|
| Is OMO pi-based? | No — OpenCode plugin; `senpi` is a separate repo | Yes via the in-tree `omo-senpi` package depending on `@code-yeongyu/senpi` | Source. Both are partly right: OMO is an OpenCode plugin *and* vendors a Senpi adapter |
| OMO default branch | Implied `main`/`dev` | No `main` exists; `dev` is default | Source (branch listing) |
| Gajae star count | ~2.3k | not asserted | Web, low confidence and irrelevant to the verdict |
| Pi identity | `earendil-works/pi`, formerly `badlogic/pi-mono` | consistent | Agreed |

The web agent's own "what the web does not answer" list named the Senpi-vs-Pi
adapter question as unresolvable from public pages. It was right, and the source
read settled it.

## 5. What this unit does NOT do

No export client is added here. `000` §Scope keeps `src/` out, and both verdicts
above describe work for a *future* unit. This document exists so that unit starts
from measured facts rather than from a second round of the same research.

Recheck before acting: OMO's v4.19.4 release notes call it the last release
before a native CLI line, so the Senpi adapter's shape may move.

## 6. Sources

Every decisive claim is anchored to an immutable commit or tag. `main`/`dev`
URLs are mutable and cannot prove this snapshot, so they are not used as
evidence anchors.

### Inspected revisions

| Repository | Ref | SHA / tag |
|---|---|---|
| `Yeachan-Heo/gajae-code` | `main` | `5f2e7cd05e8ea344991566f9ed96f1f9c66226bd` |
| `Yeachan-Heo/gajae-code` | `dev` | `280ce5f3515ea2366c3bf3eaf1331a3f2a63282f` |
| `code-yeongyu/oh-my-openagent` | `dev` (default) | `b072d279110bdda2c6ac2525d0d24dc54d16148a` |
| `code-yeongyu/oh-my-openagent` | `master` | `86db5c02df8568f669c8b42789934ea0753f135b` |
| `code-yeongyu/senpi` | `v2026.7.26` | `539c8a5c30dd1599d790052eed6609dfa0572c4f` |

### Decisive claims and their anchors

| Claim | Anchor |
|---|---|
| Gajae merged a read-only OpenCodex provider on 2026-08-01 | [PR #3698](https://github.com/Yeachan-Heo/gajae-code/pull/3698) |
| Gajae config path is `~/.gjc/agent/models.yml`, YAML, with legacy JSON migration | [`docs/models.md#L15-L24`](https://github.com/Yeachan-Heo/gajae-code/blob/5f2e7cd05e8ea344991566f9ed96f1f9c66226bd/docs/models.md#L15-L24) — **path and format only**; this anchor evidences no auth field |
| Gajae provider schema accepts `baseUrl`, `apiKey`, `apiKeyEnv`, `api`, `headers`, `authHeader`, `auth`, `models` | [`models-config-schema.ts#L113-L155`](https://github.com/Yeachan-Heo/gajae-code/blob/5f2e7cd05e8ea344991566f9ed96f1f9c66226bd/packages/coding-agent/src/config/models-config-schema.ts#L113-L155) — the auth-field claim rests **here** |
| `apiKeyEnv` resolves strictly from `Bun.env` | [`model-registry.ts#L574-L587`](https://github.com/Yeachan-Heo/gajae-code/blob/5f2e7cd05e8ea344991566f9ed96f1f9c66226bd/packages/coding-agent/src/config/model-registry.ts#L574-L587) |
| OMO depends on `@code-yeongyu/senpi@2026.7.26` | [`packages/omo-senpi/package.json#L26-L52`](https://github.com/code-yeongyu/oh-my-openagent/blob/b072d279110bdda2c6ac2525d0d24dc54d16148a/packages/omo-senpi/package.json#L26-L52) |
| Senpi renames the config dir to `.senpi` | [`packages/coding-agent/package.json#L1-L11`](https://github.com/code-yeongyu/senpi/blob/539c8a5c30dd1599d790052eed6609dfa0572c4f/packages/coding-agent/package.json#L1-L11) |
| Senpi resolves `~/.senpi/agent/models.json`, `SENPI_CODING_AGENT_DIR` override | [`src/config.ts#L487-L530`](https://github.com/code-yeongyu/senpi/blob/539c8a5c30dd1599d790052eed6609dfa0572c4f/packages/coding-agent/src/config.ts#L487-L530) |
| Senpi provider schema accepts our shape | [`model-config-schema.ts#L154-L227`](https://github.com/code-yeongyu/senpi/blob/539c8a5c30dd1599d790052eed6609dfa0572c4f/packages/coding-agent/src/core/model-config-schema.ts#L154-L227) |
| Selector splits on the first slash only | [`model-string-parser.ts#L39-L64`](https://github.com/code-yeongyu/oh-my-openagent/blob/b072d279110bdda2c6ac2525d0d24dc54d16148a/packages/model-core/src/model-string-parser.ts#L39-L64) |
| OMO installer registers into Senpi `settings.json`, not `omo.jsonc` | [`install-senpi.ts#L69-L138`](https://github.com/code-yeongyu/oh-my-openagent/blob/b072d279110bdda2c6ac2525d0d24dc54d16148a/packages/omo-senpi/src/install/install-senpi.ts#L69-L138) |
| `dev` is 1,185 commits ahead of `master` | [`master...dev`](https://github.com/code-yeongyu/oh-my-openagent/compare/master...dev) |
| Our Pi export was accepted by Senpi's validator once | Measured but unarchived; not a checked-in fact — see §Validator artifact below |

### Validator artifact

The `SENPI_SCHEMA_VALID=true` result came from generating a current opencodex Pi
export document and feeding it to Senpi 2026.7.26's own runtime schema validator
in a scratch clone. **The scratch tree was trashed after the run, so the artifact
is not reproducible from this repository.**

To re-establish it, a future unit must: install or clone
`@code-yeongyu/senpi@2026.7.26`, produce a document with
`buildPiClientConfig` (or `ocx export --client pi --json`), invoke the package's
model-config schema parser on it, and record the command plus its stdout into
this unit before relying on the claim. Until that is done, treat the result as a
**measured but unarchived** finding — stronger than schema reading, weaker than
a checked-in fixture.
