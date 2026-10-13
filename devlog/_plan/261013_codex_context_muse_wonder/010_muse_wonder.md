# wp1 — Muse Wonder on the Meta providers

MODIFY src/providers/registry/model-seeds.ts (after META_MUSE_MODELS):
  export const META_MUSE_WONDER_MODEL = "muse-wonder-1.0";
  export const META_MODEL_API_MODELS = [...META_MUSE_MODELS, META_MUSE_WONDER_MODEL];
  // Model API efforts: Spark stops at xhigh; Wonder documents minimal..max (dev.meta.ai/docs/models, 2026-10-13).
  export const META_MODEL_API_REASONING_EFFORTS: Record<string, string[]> = { ...Spark ids -> META_MUSE_REASONING_EFFORTS, wonder -> META_MUSE_CODE_REASONING_EFFORTS };
  export const META_MODEL_API_REASONING_EFFORT_MAPS: matching identity maps.
MODIFY src/providers/registry/entries-core.ts:
  meta-model: models META_MODEL_API_MODELS; modelContextWindows/modelInputModalities over META_MODEL_API_MODELS;
  modelReasoningEfforts META_MODEL_API_REASONING_EFFORTS; modelReasoningEffortMap META_MODEL_API_REASONING_EFFORT_MAPS;
  note: add "Muse Wonder (muse-wonder-1.0, preview) is Standard mode only: $4/$20 per 1M, no Contributor tier".
  meta-muse: models META_MODEL_API_MODELS; windows/modalities/efforts (META_MUSE_CODE_*) over META_MODEL_API_MODELS.
  defaultModel stays muse-spark-1.3 (Wonder is preview).
MODIFY src/usage/expected-prices.ts: META_MUSE_WONDER_10 = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 };
  rows meta-model/muse-wonder-1.0 (verified, 2026-10-13) and meta-muse/muse-wonder-1.0 (verified-derived).
MODIFY docs-site/src/content/docs/guides/providers.md Meta Model API paragraph: three models, Wonder ladder adds max, Standard only.
NEW tests/providers/meta-muse-wonder.test.ts: both providers list muse-wonder-1.0 with 1,048,576 window, text+image,
  Wonder efforts include max while meta-model Spark rows stop at xhigh, defaultModel unchanged, price overlays exact.
  Register in scripts/test-layout/layout.json (appended to an existing providers line) and tests/fixtures/test-layout-expected.json.
OUT: resellers (command-code, opencode-go, cursor) until they publish Wonder; Muse Wonder Full (no Model API id).


## Audit round 1 folds (Hypatia FAIL -> folded)

- MODIFY tests/providers/meta-model-api-provider.test.ts:73, tests/providers/meta-muse-oauth.test.ts:89,
  tests/providers/provider-registry-parity.test.ts:178: roster expectations become META_MODEL_API_MODELS; Spark-only
  effort assertions stay separate.
- MODIFY structure/providers-and-adapters.md:367: the xhigh ceiling applies to Spark; Wonder documents minimal..max.
- MODIFY docs-site/src/content/docs/guides/providers.md:932 and :936 (Muse Code section): three seeded models; Spark
  vs Wonder ladders.
- NEW test cases: Wonder request wire carries reasoning.effort "minimal" and "max" unchanged on meta-model (identity map);
  catalog projection exposes muse-wonder-1.0 with 1,048,576 context and the minimal..max ladder.
- meta-muse Wonder max is the model contract, not proof of subscription entitlement; price stays verified-derived.
