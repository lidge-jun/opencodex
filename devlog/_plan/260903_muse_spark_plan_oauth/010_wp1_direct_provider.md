# wp1 — direct Meta Model API provider

Single PR. Base: `dev`. Branch: `codex/meta-model-api-provider`.

Every value below is a `001` ledger row. Nothing is added by resemblance to a
neighbouring provider.

**Revised after the A-gate audit (round 1, FAIL, 8 blockers).** Six changes below carry
an audit provenance note. The two that mattered most were invisible from the docs and
only showed up in the repository: the provider id would have hijacked an existing model
namespace, and the advertised `minimal` effort would have been silently rewritten to
`low` on the wire.

## MODIFY `src/providers/registry.ts`

### 1. Constants, beside the other provider ladders (near `OPENAI_API_GPT56_REASONING_EFFORTS`, line ~437)

```ts
/*
 * Meta Model API (https://api.meta.ai/v1). Published ladder, NOT the usual house set:
 * /docs/reasoning lists "none", "minimal", "low", "medium", "high", "xhigh" and then
 * excludes "none" for Muse Spark specifically ("not supported by Muse Spark and
 * returns HTTP 400"). "max" and "ultra" are absent from the vendor's list entirely,
 * so appending one by family resemblance would invent a wire value.
 *
 * Corroborated against a second surface: an unauthenticated OpenCode Zen probe of
 * muse-spark-1.3-contributor-free on 2026-09-03 accepted minimal..xhigh and rejected
 * max/ultra with \`unknown variant\`, and rejected none with "does not support none
 * with this model".
 */
const META_MUSE_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

/*
 * Identity wire map (audit blocker 3). `requestToCodexEffort` in
 * src/reasoning-effort.ts:171 rewrites `minimal` to `low` unless a model-scoped wire
 * map says otherwise. Without this the picker would advertise an effort the wire never
 * sends, and a registry-array assertion would happily pass while the request body was
 * wrong. The map is identity because Meta's values ARE the Codex names.
 */
const META_MUSE_REASONING_EFFORT_MAP: Record<string, string> = Object.fromEntries(
  META_MUSE_REASONING_EFFORTS.map(effort => [effort, effort]),
);

/** Muse Spark 1.3 and its Contributor tier both publish a 1,048,576-token window (/docs/models). */
const META_MUSE_CONTEXT_WINDOW = 1_048_576;

const META_MUSE_MODELS = ["muse-spark-1.3", "muse-spark-1.3-contributor"];
```

### 2. The provider entry, after the `openai-apikey` entry (line ~1450)

**Id is `meta-model`, not `meta` (audit blocker 1).** Two independent collisions, both
verified in the tree:

- `src/router.ts:676` resolves a `<provider>/<model>` prefix against configured
  providers first. Registering `meta` would make the existing Command Code native
  selector `meta/muse-spark-1.3` — already live on `dev` since #3317 — silently change
  destination the moment a user configured the direct provider. A working model
  reference would start billing somewhere else, with no error.
- `src/cli/init.ts:72` derives the env var as `${ID.toUpperCase()}_API_KEY`, so id
  `meta` yields `META_API_KEY` — which is the **Muse Code CLI's** variable, not the
  Model API's `MODEL_API_KEY`. Two different credentials under one name.

`meta-model` derives `META_MODEL_API_KEY` and collides with neither.

```ts
  {
    id: "meta-model",
    label: "Meta Model API",
    adapter: "openai-responses",
    baseUrl: "https://api.meta.ai/v1",
    authKind: "key",
    featured: false,
    dashboardUrl: "https://dev.meta.ai/docs/authentication",
    defaultModel: "muse-spark-1.3",
    models: META_MUSE_MODELS,
    /*
     * Static roster (audit blocker 4). Meta serves several families on this base URL —
     * Muse Image, Muse Voice Transcribe (wss://.../asr/realtime) — and we hold no key,
     * so no authenticated /v1/models payload was ever observed. `liveModels: true`
     * would publish that unseen roster into the picker, including models this
     * Responses-agent provider cannot drive. Seed the two ids the vendor documents;
     * revisit with a real payload fixture.
     */
    liveModels: false,
    /*
     * Audit blocker 2. A user may already own a custom provider named `meta-model`
     * pointing somewhere else; without this, registry.ts:2995 canonicalizes its
     * adapter and base URL and their saved key gets sent to Meta. registry.ts:147
     * names this the required protection for a newly promoted id.
     */
    preserveCustomDestination: true,
    /*
     * Responses, not Chat. Meta publishes both POST /v1/responses and
     * POST /v1/chat/completions at the same base URL and calls Responses "the
     * recommended default for new work ... OpenAI-compatible and exposes the full
     * feature set", including reasoning replay across tool turns and native
     * input_image parts. Registering this as openai-chat would reach the model and
     * silently forfeit both.
     */
    modelContextWindows: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_CONTEXT_WINDOW])),
    modelInputModalities: Object.fromEntries(META_MUSE_MODELS.map(id => [id, ["text", "image"]])),
    modelReasoningEfforts: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_REASONING_EFFORTS])),
    modelReasoningEffortMap: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_REASONING_EFFORT_MAP])),
    /*
     * The disclosure is folded in here rather than shipped as a second stacked PR
     * (audit blocker 7): it is one string on this same entry, so a separate layer buys
     * a second CI and review cycle and no reviewability.
     */
    note: "Pay-as-you-go Meta Model API. Get a key at https://dev.meta.ai — a Meta developer account needs a payment method before it can serve requests, and every call is metered per token. A Muse Code subscription does NOT apply here: Meta scopes that credential to the Muse Code CLI and bills any other key pay-as-you-go (dev.meta.ai/docs/muse-code/subscriptions). The Contributor tier (muse-spark-1.3-contributor) is ~92% cheaper because Meta trains on your prompts; do not send confidential material through it. Muse Spark is also reachable through the command-code and opencode-go providers.",
  },
```

Three deliberate omissions, each one a fact the vendor does not publish:

- **No `defaultMaxOutputTokens`.** `001` §B: the only number available (`131072`)
  lives inside a third-party config sample and the docs call the real limit
  "model-dependent". Declaring it would be a capability claim we cannot source.
- **No video/audio/PDF in `modelInputModalities`.** The catalog enum is
  `text`/`image` — `tests/catalog-input-modality-enum.test.ts` exists precisely
  because a provider once advertised `video` and poisoned the exported config.
  Audio is documented as degraded on 1.3 anyway.
- **No rate-limit metadata.** The pricing page carries an unremoved internal note
  asking someone to confirm those numbers pre-launch (`001` provenance caveat).
- **No `oauthId`.** A device-code-shaped login does exist (`002`), but the credential it
  yields is licensed to the Muse Code CLI alone, so wp2 closed `NOOP` and no OAuth is
  wired (`020`). This entry is key-auth only.

## MODIFY `tests/provider-registry-parity.test.ts`

`EXPECTED_KEY_PROVIDER_IDS` at line 33 is a hardcoded roster and the assertion compares
**order**, not set membership. Insert `"meta-model"` immediately after
`"openai-apikey"`, matching where the entry sits in the registry — appending it to the
end fails (audit round 3, blocker 1).

## MODIFY `src/usage/expected-prices.ts` and `tests/usage-cost.test.ts`

Decided, not deferred (audit round 2, blocker 4). `src/usage/cost.ts:267` resolves a
generated-metadata alias first and `meta-model` has none, so an unpriced row falls all
the way through and reports nothing. Two overlays, values from `001` §B and
corroborated by the Command Code payload:

Complete `ExpectedPriceOverlay` objects — `source`, `verifiedAt`, and `status` are
required, and the earlier draft's trailing `...` would not compile (audit round 3,
blocker 2):

```ts
const META_MODEL_PRICING = "https://dev.meta.ai/docs/pricing-rate-limits";

  { provider: "meta-model", modelId: "muse-spark-1.3",
    cost4: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
    source: `Meta Model API published price ${META_MODEL_PRICING}; cached input billed at 0.12x base input`,
    verifiedAt: "2026-09-03", status: "verified" },
  { provider: "meta-model", modelId: "muse-spark-1.3-contributor",
    cost4: { input: 0.10, output: 0.20, cacheRead: 0.002, cacheWrite: 0 },
    source: `Meta Model API published Contributor-tier price ${META_MODEL_PRICING}; data-sharing discount tier`,
    verifiedAt: "2026-09-03", status: "verified" },
```

`status: "verified"` rather than `"verified-derived"`: these are Meta's own list prices
for Meta's own endpoint, read from the vendor page and independently corroborated by the
Command Code payload — no cross-surface inference is involved.

`cacheWrite` is `0` because Meta publishes no cache-write charge, the same shape
`GEMINI_31_PRO` already uses.

`tests/usage-cost.test.ts:300` pins the overlay count at 64 — update to 66 in the same
commit and add exact-lookup assertions for both ids.

## NEW `tests/meta-model-api-provider.test.ts`

Seven tests, each pinning a ledger row that a future edit could silently break:

```ts
import { describe, expect, test } from "bun:test";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { providerConfigSeed } from "../src/providers/derive";

describe("Meta Model API provider (meta-model)", () => {
  test("routes to the published OpenAI-compatible Responses base URL", () => {
    const entry = getProviderRegistryEntry("meta-model");
    expect(entry?.baseUrl).toBe("https://api.meta.ai/v1");
    expect(entry?.adapter).toBe("openai-responses");
    expect(entry?.authKind).toBe("key");
  });

  test("advertises exactly the vendor's effort ladder", () => {
    const entry = getProviderRegistryEntry("meta-model");
    for (const id of ["muse-spark-1.3", "muse-spark-1.3-contributor"]) {
      expect(entry?.modelReasoningEfforts?.[id]).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    }
  });

  test("never advertises an effort the vendor rejects", () => {
    const entry = getProviderRegistryEntry("meta-model");
    const efforts = entry?.modelReasoningEfforts?.["muse-spark-1.3"] ?? [];
    // none -> HTTP 400 on Muse Spark; max/ultra are not in the published set at all.
    for (const forbidden of ["none", "max", "ultra"]) expect(efforts).not.toContain(forbidden);
  });

  test("declares the published 1M window for both tiers", () => {
    const entry = getProviderRegistryEntry("meta-model");
    for (const id of ["muse-spark-1.3", "muse-spark-1.3-contributor"]) {
      expect(entry?.modelContextWindows?.[id]).toBe(1_048_576);
    }
  });

  test("advertises no modality outside the catalog enum", () => {
    const entry = getProviderRegistryEntry("meta-model");
    for (const id of ["muse-spark-1.3", "muse-spark-1.3-contributor"]) {
      expect(entry?.modelInputModalities?.[id]).toEqual(["text", "image"]);
    }
  });

  test("claims no max-output limit, because the vendor publishes none", () => {
    const entry = getProviderRegistryEntry("meta-model");
    expect(entry?.defaultMaxOutputTokens).toBeUndefined();
  });

  test("the seed survives derive() intact", () => {
    const entry = getProviderRegistryEntry("meta-model")!;
    const seed = providerConfigSeed(entry);
    expect(seed.baseUrl).toBe("https://api.meta.ai/v1");
    expect(seed.modelContextWindows?.["muse-spark-1.3"]).toBe(1_048_576);
  });
});
```

## Behavior-level tests the audit demanded (blockers 1, 3, 6)

Registry-shape assertions alone would have passed against all three defects. Add:

**Every registry lookup in this suite uses `getProviderRegistryEntry("meta-model")`.**
The id changed after the first draft; a stale `"meta"` returns `undefined` and the
non-null seed lookup throws (audit round 2, blocker 3). Required cases:

| Case | Asserts | Why a registry-shape check is not enough |
|---|---|---|
| namespace | `routeModel(cfg, "meta/muse-spark-1.3").providerName === "command-code"` with BOTH providers configured | the live Command Code selector must survive; note the field is `providerName`, not `provider` (`src/router.ts:61`) |
| wire effort | built Responses body has `reasoning.effort === "minimal"` | the registry array looked right while `reasoning-effort.ts:171` rewrote it |
| destination | a same-named custom provider keeps its base URL, adapter, and key | `preserveCustomDestination` |
| roster | `liveModels === false` | an unseen authenticated roster must not reach the picker |
| disclosure | note contains the subscription and training warnings | folding it into wp1 must not lose its regression (audit round 2, blocker 3) |
| transport | `baseUrl`, `adapter`, `authKind`, ladder, window, modalities, absent `defaultMaxOutputTokens` | ledger rows |

B writes these against the real helpers — `routeModel` and the Responses adapter's
`buildRequest` — with real fixtures.

## Documentation (audit blocker 6)

`src/AGENTS.md:29` requires user-facing configuration changes to reach `docs-site/`.
A new provider is one. B adds the row to the English provider table only; translated
locales are left alone rather than machine-guessed.

## Verification

`bun test tests/meta-model-api-provider.test.ts tests/provider-registry-parity.test.ts tests/usage-cost.test.ts`
— all three unconditionally, since both overlays are now mandatory — then
`bun run test:changed` (`src/AGENTS.md:26` requires it once the touch set is broader
than one file; it is import-graph-scoped, not the forbidden repository-wide suite), then
`bun x tsc --noEmit` and `bun run privacy:scan` (this change ships credential guidance).

Because the touch set includes `docs-site/`, `docs-site/AGENTS.md` additionally requires
the site build — "do not claim documentation validation passed unless this build
completes successfully":

```bash
cd docs-site && bun install --frozen-lockfile && bun run build
```

Branch from the current `origin/dev` tip, not from a remembered SHA: `dev` moved during
the audit rounds.
