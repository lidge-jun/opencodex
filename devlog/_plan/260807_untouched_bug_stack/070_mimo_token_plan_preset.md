# 070 — #1158: MiMo token-plan rejects Responses custom tools

## Defect

Xiaomi MiMo's paid token-plan endpoint (`https://token-plan-cn.xiaomimimo.com/v1`)
speaks the Responses wire for plain requests but rejects `type: "custom"` tools
with `400 responses_feature_not_supported`. Codex emits custom tools for
`apply_patch` and other freeform tools, so an agentic turn fails on this
provider while a plain chat turn succeeds.

The reporter confirmed the same account works fully through `openai-chat`.

Current state, verified on the tree:

- `src/adapters/openai-responses.ts` filters only model-declared hosted tools;
  arbitrary custom tools are serialized unchanged.
- `src/providers/registry.ts:2017` has `xiaomi` (Anthropic wire) and `:2020`
  has `mimo-free` (free tier, own adapter). **No token-plan preset exists.**

So a token-plan user hand-rolls the provider, and because MiMo documents
Responses support they naturally pick `openai-responses` — the one wire that
breaks.

## Why a preset rather than tool stripping

Two rejected alternatives, both worse:

**Strip custom tools for this provider.** `apply_patch` IS a custom tool, so
stripping it disables the Codex agent loop. The user would get a provider that
no longer 400s and no longer edits files. Spark's specialized stripping
(`openai-responses.ts:248-353`) does exactly this and is not a model to follow
here.

**`modelWireDefaults`.** That mechanism moves individual models between wires.
The known-good wire here is provider-wide, not per-model, so a preset states the
fact directly instead of repeating it per model.

The Chat path already handles custom tools correctly: `src/responses/parser.ts`
lowers them to `{input: string}` functions and `src/bridge.ts` restores them as
`custom_tool_call`. Nothing needs building — the provider just has to be pointed
at the wire that works.

## Change

Add a registry entry beside the existing Xiaomi ones:

```
id:          "mimo"
label:       "Xiaomi MiMo (token plan)"
baseUrl:     "https://token-plan-cn.xiaomimimo.com/v1"
adapter:     "openai-chat"
authKind:    "key"
models:      mimo-v2.5-pro, mimo-v2.5
efforts:     low | medium | high per model
effortMap:   xhigh/max/ultra -> high
preserveCustomDestination: true
```

`preserveCustomDestination` matters: someone may already have a hand-rolled
provider named `mimo`, and without it `routedProviderConfig()` would canonicalize
their base URL onto ours — silently retargeting their key at a different host.
The same hazard the `zhipu-bigmodel` comment documents at `registry.ts:1668`.

The effort clamp is because MiMo's ladder stops at `high`; forwarding `ultra`
would send a value the provider rejects.

## Tests

**Preset shape** — `tests/provider-registry-parity.test.ts`, `MiMo token-plan
preset uses Chat and clamps extended efforts`. Assert the derived key-login
provider's adapter, base URL, and models, and that the effort map collapses the
three extended tiers to `high`. Add the id to `EXPECTED_KEY_PROVIDER_IDS`; the
parity test fails without that, which is the intended gate.

**Collision preservation** — the shape test does NOT exercise the claim this
plan actually leans on. `preserveCustomDestination` is only consulted when the
configured endpoint, adapter, or auth differs
(`src/providers/registry.ts:2111-2124`), and only then does
`routedProviderConfig()` keep the user's row (`src/router.ts:254-258`). So the
regression has to route, not just inspect metadata: define a pre-existing
provider named `mimo` pointing somewhere else with a different adapter, route
through it, and assert its base URL, adapter, and key are untouched. Follow the
shape of `tests/cline-pass-provider.test.ts:163-183`.

Without that second test the plan asserts a safety property it never checks —
and silently retargeting an existing user's key at another host is precisely the
failure the `zhipu-bigmodel` comment warns about.

## Blast radius

Registry-derived key login, `ocx init`, the provider picker, and catalog
metadata. `xiaomi` and `mimo-free` are untouched — different hosts, different
wires.

## What this does not do

It does not make the Responses wire work on this endpoint. If MiMo later accepts
custom tools there, the preset is the thing to revisit. The issue asked for
"preset or guidance"; this is the preset, and the note field carries the
guidance.
