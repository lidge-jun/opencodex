# 020 — Layer 2: text-only Zen models reject images (#1043, live half of #1024)

## The defect

`opencode-zen` (`src/providers/registry.ts:1652`) declares neither
`noVisionModels` nor modality metadata. Image stripping and sidecar activation
both key on `noVisionModels` membership (`src/vision/index.ts:192-211`,
`src/server/responses/core.ts:1689-1692`), so an image part is forwarded verbatim
to a text-only model and the upstream rejects the whole request with a 400.

Reproduced live — see `002`. `big-pickle` returns exactly the error quoted in the
issue.

## Why not the reporter's suggested fix

The issue proposes stripping whenever `inputModalities` lacks `"image"`. Three
findings from the control-flow lane make that the wrong first move:

1. Zen's `GET /v1/models` returns **no capability field at all** — only `id`,
   `object`, `created`, `owned_by` (measured in `002`). So `inputModalities` is
   `undefined` for exactly these models (`src/codex/catalog/provider-fetch.ts:719-743`).
2. Live-discovered modalities are never copied into the request-time provider
   config (`src/router.ts:84-110`), so vision planning cannot see them anyway.
3. A deliberate regression guard asserts unlisted models keep forwarding images
   (`tests/vision-sidecar-e2e.test.ts:163-193`). Flipping the default breaks a
   contract someone wrote on purpose.

A modality-keyed default would therefore change behavior everywhere *except* the
provider that motivated the issue. The narrow classification fixes the actual
report; the modality-driven default is a follow-up that needs the metadata to
become canonical first.

## Change map

### `src/providers/registry.ts` — MODIFY

Add the measured constant beside the existing OpenCode lists (near `:350`):

```ts
// Measured against https://opencode.ai/zen/v1 on 2026-08-05, one image request per
// model (devlog/_fin/260805_bug_fix_stack/002_zen_modality_probe.md). Zen publishes
// no modality field, so this list is empirical, not derived. mimo-v2.5-free and
// longcat-2.0-free ACCEPT images and are deliberately absent.
const OPENCODE_ZEN_TEXT_ONLY_MODELS = [
  "big-pickle",
  "nemotron-3-ultra-free",
  "ling-3.0-flash-free",
  "north-mini-code-free",
  "laguna-s-2.1-free",
  "deepseek-v4-flash-free",
];
```

Then attach it to the `opencode-zen` entry at `:1652`, which currently has no
`noVisionModels`:

```ts
// BEFORE
{ id: "opencode-zen", label: "opencode zen", baseUrl: "https://opencode.ai/zen/v1",
  adapter: "openai-chat", authKind: "key", dashboardUrl: "https://opencode.ai/auth" },

// AFTER
{ id: "opencode-zen", label: "opencode zen", baseUrl: "https://opencode.ai/zen/v1",
  adapter: "openai-chat", authKind: "key", dashboardUrl: "https://opencode.ai/auth",
  noVisionModels: OPENCODE_ZEN_TEXT_ONLY_MODELS },

// and widen the sibling free entry from the DeepSeek-only list
//   :1671  noVisionModels: OPENCODE_FREE_DEEPSEEK_MODELS,
// to
//   :1671  noVisionModels: OPENCODE_ZEN_TEXT_ONLY_MODELS,
```

The sibling `opencode-free` entry at `:1655-1671` already does exactly this
against the same base URL, so this is the established shape for this vendor, not
a new mechanism.

### Does free-tier evidence justify touching the key-auth entry?

The audit's sharpest objection: the probe ran unauthenticated, and `opencode-zen`
is `authKind: "key"`. Applying one tier's evidence to another is how a user's
image gets silently destroyed.

Re-probed with the desktop header removed entirely (`002`, follow-up section):
`big-pickle` rejects `image_url` identically with no header, `mimo-v2.5-free`
narrates the image with no header, and a bogus bearer token returns `AuthError`
before any model logic runs. So capability is enforced upstream of authentication
and the header was never load-bearing — the evidence does transfer for these IDs.

What stays unproven is whether an authenticated account is served a *different
roster* under the same names. Two things bound that risk. The list is
fail-**closed** only for IDs measured to reject images, so a wrong entry costs a
caption instead of a hard 400; and `#1024` already reports real users hitting the
text-only failure through this provider, so the population being protected is not
hypothetical.

If a maintainer with a Zen key disagrees, the correct narrowing is to move the
list to `opencode-free` alone. That is recorded as the fallback, not chosen,
because it would leave the reporter's own provider unfixed.

**Accepted residual risk, stated for the PR.** Two audit rounds narrowed this and
neither closed it fully. Authenticated-tier equivalence is unproven for all eight
IDs, and the reviewer's own spaced re-probes of `mimo-v2.5-free` returned a 400
and a 502 where ours returned 200 twice — the free route is intermittently
unstable, which is a reason to distrust any single measurement including our own.

What survives that instability: `big-pickle`'s rejection reproduced identically
across four attempts, with and without the header, and its error text matches the
issue verbatim. The six listed IDs are the ones that failed consistently; the two
excluded ones are the only two that ever returned a completion for an image.

The PR must carry this residual in its description rather than presenting the
list as settled. A maintainer with a key can close it in one command.

### Drift policy — the list is dated, not permanent

Zen's roster is discovered live (`liveModels: true` on the sibling) while this
list is static. Two failure directions, unequal in cost:

| drift | consequence | severity |
|---|---|---|
| Zen adds a text-only model we do not list | user gets the loud upstream 400 — today's behavior | tolerable, visible |
| A listed model gains vision | images silently replaced by a caption | **worse, invisible** |

The second is why the constant carries its measurement date in a comment and why
`mimo-v2.5-free` / `longcat-2.0-free` get an explicit *negative* assertion: the
guard has to survive a future well-meaning "just classify all the free models"
patch. This is a dated, measured exception list — not a capability model, and it
should be replaced by one once live modality metadata becomes canonical (the
follow-up named at the top of this doc).

### Tests

**Add:**

- a registry assertion that all six measured IDs are in `opencode-zen.noVisionModels`;
- an explicit assertion that `mimo-v2.5-free` and `longcat-2.0-free` are **not** —
  this is the guard against a future well-meaning "classify all free models" patch;
- an e2e case alongside `tests/vision-sidecar-e2e.test.ts:91-161` proving a listed
  Zen model gets its image replaced before the upstream request.

**Do not touch:** `tests/vision-sidecar-e2e.test.ts:163-193` (the unlisted-model
contract stays intact — this layer adds listings, it does not change the default).

## Red-green

The e2e assertion fails on the pre-fix tree: with no `noVisionModels`, the
upstream body contains the image bytes. After the fix it contains the omission
marker. Ablating just the registry line flips it back.

## Activation evidence (C-ACTIVATION-GROUNDING-01)

The strip path is a conditional branch, so "tests pass" is not enough. The e2e
test must assert the *observable effect* — the marker present and the image bytes
absent in the captured upstream body — not merely that the request succeeded.

## Scope note

This closes #1043. For #1024 it closes the Zen half; the `TR` /
`moonshotai/kimi-k3-free` half depends on reporter configuration for a provider
that is not in the registry, and stays open.

## Accept criteria

- Six measured IDs listed; the two vision-capable ones explicitly not.
- A test in `tests/vision-sidecar-e2e.test.ts` that fails if someone later adds
  `mimo-v2.5-free` or `longcat-2.0-free` to the list.
- The registry assertion lives in `tests/provider-registry-parity.test.ts`.
- The unlisted-model forwarding contract still green.
- `bun run typecheck` clean; vision test files pass.
