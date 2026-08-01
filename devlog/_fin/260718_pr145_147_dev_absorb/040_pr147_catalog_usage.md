# 040 — PR #147 closeout slice on `dev`: member-derived catalog and per-attempt usage

## 1. Scope and dependency

This slice lands on the green 030 tip and closes PR #147 with two observability
contracts: combo catalog rows advertise only capabilities common to every target, and
one logical combo request retains an ordered, sanitized record of every concrete target
attempt. The target is local `dev`, **not `main`**.

Source attribution follows `000_plan.md`. PR #147 source head is
`6824e7bc56f5d0b1fc6fbb6089797a951ecb4eda`; reviewed head is `a4abda10`.
Because both final designs materially replace contributor implementations, commits are
authored by `bitkyc08-arch <bitkyc08@gmail.com>` with
`Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`, and bodies name the
source/reviewed heads. The contributor's intent—advertise combo virtual models and
record the provider used—is retained, but unsafe fabricated metadata and last-provider-
only accounting are not.

### Exclusions

- No change to 020 selection or 030 failover decisions.
- No new database, usage-file migration, or GUI requirement. Existing readers ignore
  additive `attempts`/`attemptCount` fields; GUI follow-up remains deferred.
- No attempt to infer an unknown member context window. An unverifiable combo is hidden
  from public catalog surfaces but remains visible in `/api/combos` for repair.
- No per-chunk billing. Usage remains terminal/provider-reported where available, with
  adapter estimates explicitly marked estimated.
- No release, push, GitHub write, or immutable-source-ref rewrite.

## 2. Current-`dev` and PR-head evidence

Required inspection:

```bash
git diff dev...codex/source-pr147-6824e7bc -- \
  src/codex/catalog.ts src/server/responses.ts src/server/request-log.ts \
  src/usage tests
nl -ba src/codex/catalog.ts | sed -n '292,305p;716,763p;1021,1085p;1291,1347p'
nl -ba src/server/request-log.ts | sed -n '23,116p;172,238p;371,430p'
nl -ba src/usage/log.ts | sed -n '1,123p'
nl -ba src/usage/summary.ts | sed -n '1,309p'
```

Current `dev` already contains PR #139/#140 catalog infrastructure absent from the PR
base:

- `CatalogModel.defaultReasoningEffort` at `src/codex/catalog.ts:292-305`;
- provider config metadata and context caps at `:1021-1080`;
- registry-enriched active providers and a stable gathered model list at `:1321-1346`;
- routed catalog emission already threads `reasoningEfforts`, default effort, context,
  max input, modalities, and parallel tools into Codex rows at `:716-763` and `:827-885`.

PR #147 appends `{ provider: "combo", id, owned_by: "combo" }` after sorting. Current
strict normalization then fabricates `input_modalities:["text"]` and a 128k context
(`src/codex/catalog.ts:431-455`). Post-review commit `6824e7bc` additionally advertises
the full routed reasoning ladder and default effort without checking members. The final
implementation must derive from the already gathered member rows and reuse current
`defaultReasoningEffort`; adding PR's conflicting `defaultReasoningLevel` is forbidden.

Current request logging has one mutable provider/model/adapter and one input estimate
(`src/server/request-log.ts:23-50`). `addFinalRequestLog` at `:371-416` attributes the
entire request to that final route and combines usage with one estimator at `:383-389`.
The persisted usage row at `src/usage/log.ts:9-29` has no attempt dimension; provider/
model summaries therefore cannot assign failed or retried combo work to the provider
that received it.

The landed 030 pipeline already owns failed-body consumption. `ConsumedComboFailure`
includes sanitized `retryAfter?` and the reserved `usage?` slot at
`src/server/responses.ts:446-453`; passthrough JSON and ordinary final non-2xx call the
same bounded consumer before any unbounded read at current `:1088-1092` and
`:1377-1382`. `handleComboResponses` prefers the callback-published failure and invokes
the bounded fallback only when no callback fired (`:588-597,623-627`). Therefore 040
must only extract usage while that already-bounded text is in scope; it must not add a
reader, restore `.text()`, reconstruct the failure, or take over callback ownership.

Two additional landed contracts constrain the final design. A physical provider literally
named `combo` is valid while zero combos are configured (`src/combos/types.ts:54-58`,
`tests/combos.test.ts:418-430`), so provider/owner metadata cannot identify virtual combo
rows. Also, sync preserves foreign routed rows at `src/codex/catalog.ts:1548-1560`, while
combo DELETE immediately refreshes the catalog at `src/server/management-api.ts:1434-1447`;
therefore the refresh must actively retire stale managed `combo/*` rows. In the request
engine, connect abort, response-after-abort, child status 499, and bounded-read abort all
return before ordinary attempt finish/push (`src/server/responses.ts:601-631`). A child
attempt that has begun must be retained as status 499 before each such return.

## 3. Final contracts

### 3.1 Catalog capability intersection

For each validated combo, resolve every normalized `provider/model` target against the
already gathered active model list. The public combo row exists only if every target is
present and every target has a positive known `contextWindow`. This is a fail-closed
catalog rule, not a runtime disable.

Derived fields:

- `contextWindow`: minimum member context;
- `maxInputTokens`: minimum of each member's `maxInputTokens ?? contextWindow`;
- `inputModalities`: set intersection, with missing member modalities conservatively
  treated as `["text"]`; image is advertised only when **all** targets effectively
  advertise image (including current vision-sidecar enrichment);
- `reasoningEfforts`: intersection of explicit member ladders; missing ladder is treated
  as empty, never as the full global ladder;
- `defaultReasoningEffort`: configured combo default if common; otherwise mirror the
  live wire clamp in `src/reasoning-effort.ts:87-105`: choose the highest common rung at
  or below the request, or the lowest common rung above it when no lower/equal rung
  exists; omitted when the common ladder has no rankable Codex effort;
- `parallelToolCalls`: true only when every member is true;
- `owned_by`: `combo`.

The combo row is appended before the final `(provider,id)` sort. `combo/<id>` obeys the
existing `disabledModels` filter. Missing member/context **or an empty modality
intersection** produces one deduplicated warning signature and no row—never a synthetic
128k/text-only capability claim. Exact combo ladders/modalities must survive both final
outputs: `buildCatalogEntries` bypasses routed mock `max`/`ultra` expansion, and
`mergeCatalogEntriesForSync` bypasses its preserved-row `max` re-add for the exact set of
configured combo slugs. Tests assert the final built `RawEntry[]` and merged sync output,
not only `deriveComboCatalogModel`.

The identity source is an authoritative `exactComboSlugs` set built from the current
validated config, never `provider === "combo"`, `owned_by === "combo"`, or the namespace
prefix alone. The same set is passed to both `buildCatalogEntries` and the sync merge. When
no physical provider named `combo` exists, sync owns the `combo/` namespace and removes
every `combo/*` row absent from the fresh derived routed set. This includes deleted combos
and configured combos that became unresolvable. When a physical `combo` provider exists,
its rows are preserved and receive ordinary routed normalization. The PUT/DELETE best-
effort refresh makes this lifecycle visible immediately after management changes.

### 3.2 Logical request plus ordered concrete attempts

The in-memory request log and persisted usage JSONL retain one parent row per client
request:

```ts
provider: "combo"
model: "combo/free"
requestedModel: "combo/free"
resolvedModel: "model-b" // final successful physical model, when known
attempts: [A, B]
```

Each attempt contains only bounded operational metadata:

```ts
{
  ordinal: 1,
  provider: "prov-a",
  model: "model-a",
  adapter: "openai-chat",
  status: 503,
  durationMs: 12,
  sendCount: 1,
  recoveryKinds: [],
  usageStatus: "unreported",
  inputTokenEstimate?: 123,
  usage?: OcxUsage,
  totalTokens?: number,
  errorCode?: string
}
```

`sendCount` counts proxy-visible upstream sends within that target. `recoveryKinds` is a
deduplicated ordered subset of `transient-5xx|connection-reset|oauth-401|key-429|image-413`.
It never contains URLs, headers, keys, request bodies, messages, account IDs, or raw
errors.

Every adapter request rebuild refreshes that target's `inputTokenEstimate`. A failed
target gets an estimated input-only usage only when its adapter provided an estimate.
The successful target receives terminal reported usage through the existing JSON/SSE
inspection path. Streaming terminal failure updates only the committed final attempt;
it cannot create another attempt after 030's commit boundary.

Cancellation is still an observable physical attempt outcome. Once a child attempt has
been created, every cancellation exit seals its safe child provider/adapter identity,
finishes it with status 499, and pushes it exactly once before returning the client-
cancelled response. These paths must not select a backup, warn, apply cooldown, call
`noteComboSuccess`, publish child callbacks, or count success. The pre-pick abort check,
which runs before an attempt exists or an upstream send can occur, remains attempt-free.

Parent usage is the sum of measured attempt usage. Parent status semantics are honest:

- `reported` only when every attempt is reported;
- `estimated` when every attempt is measured and at least one is estimated;
- `unreported` when any attempt has no measurement, even if partial token totals exist;
- `unsupported` only when every attempt is unsupported.

Top-level usage summary `requests` remains the number of logical parent requests. Model
and provider rows use attempt attribution, add `attemptCount`, and count `requests` as
distinct parent request IDs touching that dimension. Consequently provider request
counts may overlap across providers, while total logical requests never inflate.

Failed-attempt usage is captured inside 030's existing bounded read, without changing
failure-body or callback ownership:

| Failure path | Landed bounded owner | 040's only addition |
|---|---|---|
| passthrough JSON final non-2xx | `consumeComboFailure` at current `responses.ts:1088-1092` | parse usage from the bounded text and set only `failure.usage` before the existing callback publication |
| ordinary HTTP final non-2xx | `consumeComboFailure` at current `responses.ts:1377-1382` | parse usage from the bounded text and set only `failure.usage` before the existing callback publication |
| callback absent | callback-first fallback at current `responses.ts:623-627` | the same helper performs one bounded read and returns the same optional usage snapshot |

`retryAfter` remains 030's validated cooldown-only value. No raw `Retry-After` header is
forwarded to the client, and there is no post-consumption read or duplicate body owner.

## 4. Diff-level implementation

### 4.1 `src/codex/catalog.ts` + `src/server/index.ts` — MODIFY — exact identity, intersection, and final builds

Before, `gatherRoutedModels` ends with only physical rows:

```ts
  all.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
  return all;
```

After, derive verified combo rows first and perform one final sort as shown below.

Do not modify `CatalogModel`; current fields are sufficient. Add pure helpers near
`applyProviderConfigHints`:

```ts
function intersectStrings(values: readonly string[][]): string[] {
  if (values.length === 0) return [];
  const rest = values.slice(1).map(value => new Set(value));
  return [...new Set(values[0])].filter(value => rest.every(set => set.has(value)));
}

function effectiveComboDefault(
  configured: string | undefined,
  common: readonly string[],
): string | undefined {
  if (configured && common.includes(configured)) return configured;
  const requestedRank = codexEffortRank(configured ?? "medium");
  const ranked = common
    .map(effort => ({ effort, rank: codexEffortRank(effort) }))
    .filter(item => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (ranked.length === 0) return undefined;
  const atOrBelow = ranked.filter(item => item.rank <= requestedRank);
  return atOrBelow.at(-1)?.effort ?? ranked[0]!.effort;
}

export function deriveComboCatalogModel(
  id: string,
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): CatalogModel | null {
  if (combo.targets.length === 0) return null;
  if (members.length !== combo.targets.length) return null;
  const contexts = members.map(member => member.contextWindow);
  if (contexts.some(value => typeof value !== "number" || value <= 0)) return null;

  const inputModalities = intersectStrings(
    members.map(member => member.inputModalities ?? ["text"]),
  );
  if (inputModalities.length === 0) return null;
  const reasoningEfforts = intersectStrings(
    members.map(member => member.reasoningEfforts ?? []),
  );
  const contextWindow = Math.min(...contexts as number[]);
  const maxInputTokens = Math.min(...members.map(member => member.maxInputTokens ?? member.contextWindow!));
  const defaultReasoningEffort = effectiveComboDefault(combo.defaultEffort, reasoningEfforts);

  return {
    provider: "combo",
    id,
    owned_by: "combo",
    contextWindow,
    maxInputTokens,
    inputModalities,
    reasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(members.every(member => member.parallelToolCalls === true) ? { parallelToolCalls: true } : {}),
  };
}
```

The early null on an empty modality intersection is mandatory. It runs before
`deriveEntry`, so neither an inherited template modality nor
`ensureStrictCatalogFields`'s missing-field fallback at current `catalog.ts:443` can turn
an unsupported combo into `input_modalities:["text"]`.

At the first final-normalization point, preserve combo capability arrays exactly. Add an
explicit option rather than weakening the routed-model policy for physical providers:

```ts
function applyReasoningLevels(
  entry: RawEntry,
  effortsOverride?: string[],
  defaultOverride?: string,
  preserveExact = false,
): void {
  let efforts = sanitizeCodexReasoningEfforts(effortsOverride)
    ?? ROUTED_REASONING_LEVELS.map(level => level.effort);
  if (!preserveExact && efforts.length > 0) {
    // Existing max/ultra addition block remains unchanged here.
  }
  // Existing level materialization/default selection remains unchanged.
}

function isExactComboCatalogModel(
  model: CatalogModel | undefined,
  exactComboSlugs: ReadonlySet<string>,
): boolean {
  return model !== undefined
    && exactComboSlugs.has(`${model.provider}/${model.id}`);
}

function ensureStrictCatalogFields(
  entry: RawEntry,
  options: { preserveExactInputModalities?: boolean } = {},
): RawEntry {
  // Existing strict defaults remain unchanged except for this guarded line:
  if (!Array.isArray(entry.input_modalities)
    && !options.preserveExactInputModalities) entry.input_modalities = ["text"];
  // ...existing strict normalization...
  return entry;
}

// buildCatalogEntries receives exactComboSlugs and passes it through deriveEntry.
// In both template and template-free routed branches of deriveEntry:
const preserveExact = isExactComboCatalogModel(model, exactComboSlugs);
applyReasoningLevels(
  entry,
  model?.reasoningEfforts,
  model?.defaultReasoningEffort,
  preserveExact,
);
applyCatalogModelMetadata(entry, model); // copies the exact non-empty combo array
return ensureStrictCatalogFields(entry, {
  preserveExactInputModalities: preserveExact,
});
```

`applyCatalogModelMetadata` copies a combo model's already non-empty
`inputModalities` array verbatim. Do not union it with the template or default it after
the copy. Physical routed rows continue receiving the existing mock top-tier behavior.

Import `NormalizedComboConfig`, `codexEffortRank`, `getCombo`, and `targetKey` through
their current owners. Keep the non-empty/member-count checks even though 020 rejects
empty/duplicate targets; they protect callers/tests against malformed in-memory config.

At the end of `gatherRoutedModels`, replace the current immediate sort/return with:

```ts
  const memberByKey = new Map(all.map(model => [`${model.provider}/${model.id}`, model]));
  for (const id of listComboIds(config)) {
    const combo = getCombo(config, id);
    if (!combo) continue;
    const members = combo.targets
      .map(target => memberByKey.get(targetKey(target)))
      .filter((member): member is CatalogModel => member !== undefined);
    const derived = deriveComboCatalogModel(id, combo, members);
    if (derived) all.push(derived);
    else warnUncataloguedComboOnce(id, combo, members);
  }
  all.sort((a, b) => a.provider === b.provider
    ? a.id.localeCompare(b.id)
    : a.provider.localeCompare(b.provider));
  return all;
```

Add the complete warning owner near the existing catalog warning maps. It hashes sorted
target IDs plus discovered capability values, but logs only redacted/capped IDs:

```ts
import { redactSecretString } from "../lib/redact";

const comboCatalogWarningSignatures = new Map<string, string>();

function safeCatalogWarningLabel(value: string): string {
  return redactSecretString(value)
    .replace(/[\u0000-\u001f\u007f]/g, "?")
    .slice(0, 200);
}

function comboCatalogWarningSignature(
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): string {
  const discovered = new Map<string, CatalogModel>(members.map(member => [
    `${member.provider}/${member.id}`,
    member,
  ] as const));
  return JSON.stringify(combo.targets.map(target => {
    const key = targetKey(target);
    const member = discovered.get(key);
    return {
      key,
      contextWindow: member?.contextWindow ?? null,
      maxInputTokens: member?.maxInputTokens ?? null,
      inputModalities: [...new Set(member?.inputModalities ?? [])].sort(),
      reasoningEfforts: [...new Set(member?.reasoningEfforts ?? [])].sort(),
      parallelToolCalls: member?.parallelToolCalls === true,
    };
  }).sort((a, b) => a.key.localeCompare(b.key)));
}

function warnUncataloguedComboOnce(
  id: string,
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): void {
  const signature = comboCatalogWarningSignature(combo, members);
  if (comboCatalogWarningSignatures.get(id) === signature) return;
  comboCatalogWarningSignatures.set(id, signature);
  const targets = combo.targets
    .map(target => safeCatalogWarningLabel(targetKey(target)))
    .sort((a, b) => a.localeCompare(b));
  console.warn(
    `[opencodex] Combo "${safeCatalogWarningLabel(id)}" is omitted from the catalog because member capabilities are incomplete: ${targets.join(", ")}.`,
  );
}
```

Extend `resetCatalogRuntimeStateForTests()` with
`comboCatalogWarningSignatures.clear()`. The signature remains internal and may contain
capability values; warning text names only the sanitized combo and provider/model IDs,
never URLs, headers, request bodies, or credentials.

At both final-normalization entry points, pass the exact configured combo slug set and
bypass only rows in that set. This avoids classifying a physical provider literally named
`combo` as virtual:

```ts
export function exactComboCatalogSlugs(config: OcxConfig): Set<string> {
  return new Set(listComboIds(config).map(comboModelId));
}

// Direct /v1/models?client_version build at src/server/index.ts:291.
const liveExactComboSlugs = exactComboCatalogSlugs(config);
const entries = buildCatalogEntries(
  loadCatalogTemplate(), nativeSlugs, goOrdered, config.subagentModels,
  websocketsEnabled(config), maMode, liveExactComboSlugs,
);

// syncCatalogModels: derive identities and namespace ownership from the same config.
const exactComboSlugs = exactComboCatalogSlugs(config);
const hasPhysicalComboProvider = Object.hasOwn(config.providers, COMBO_NAMESPACE);
const goEntries = buildCatalogEntries(
  template ? JSON.parse(JSON.stringify(template)) : null,
  [], orderedGoModels, featured, websocketsEnabled(config), multiAgentMode,
  exactComboSlugs,
);
catalog.models = mergeCatalogEntriesForSync(
  catalog.models ?? [], goEntries, baseline, featured, wsEnabled, goIds, template,
  disabledNativeSlugs(config), gatheredProviderNames, multiAgentMode, exactComboSlugs,
  hasPhysicalComboProvider,
);

// buildCatalogEntries/deriveEntry exact-capability decision:
const preserveExact = isExactComboCatalogModel(model, exactComboSlugs);

// mergeCatalogEntriesForSync final map:
const exactCombo = typeof m.slug === "string" && exactComboSlugs.has(m.slug);
const normalized = normalizeServiceTiers(m);
applyNativeOpenAiContextOverride(normalized);
const e = ensureStrictCatalogFields(normalized, {
  preserveExactInputModalities: exactCombo,
});
if (!exactCombo) {
  // Existing current catalog.ts:1575-1587 max re-add block remains unchanged.
}
```

Add an optional final `exactComboSlugs: ReadonlySet<string>` parameter to
`buildCatalogEntries` and thread it through every routed `deriveEntry` call; direct callers
that do not have config pass an empty set. Export `exactComboCatalogSlugs(config)` from
`src/codex/catalog.ts`; both the live `/v1/models?client_version` build at
`src/server/index.ts:291` and `syncCatalogModels` call it and pass the result. Thus no
production build path infers exact identity from `provider` or `owned_by`.
`mergeCatalogEntriesForSync` receives the same set plus `hasPhysicalComboProvider`. Before
either preservation branch reaches the final map, compute `freshSlugs` from
`routedEntries`. If `hasPhysicalComboProvider` is false,
filter `finalRoutedEntries` so a `combo/*` slug survives only when `freshSlugs.has(slug)`;
this filter also applies to the `preservingExistingRouted` branch at current
`catalog.ts:1548-1553`. If the physical provider exists, skip namespace cleanup entirely.
This rule deliberately uses the fresh derived set rather than `exactComboSlugs`: a still-
configured but newly unresolvable combo must disappear instead of preserving its prior row.

Before the final map, also drop a fresh exact combo row unless `input_modalities` is a
non-empty array; never repair it to text. The exact slug set controls only exact-capability
normalization, so sync cannot append `max` to a derived intersection. The namespace rule
controls stale-row retirement without touching physical-provider rows.
`tests/codex-catalog.test.ts` must exercise both template and template-free
`buildCatalogEntries` plus `mergeCatalogEntriesForSync`, asserting the final
`supported_reasoning_levels`, `default_reasoning_level`, and `input_modalities` exactly
match the derived combo and that disjoint modalities produce no final row.
Add final-sync lifecycle cases proving: (1) a physical `combo/model` row is preserved when
zero combos are configured; (2) deleting the last combo removes its old row on the
management-triggered refresh; and (3) changing a combo from resolvable to unresolvable
hides the prior row rather than preserving it as foreign.

### 4.2 `src/usage/log.ts` — MODIFY — canonical persisted attempt shape and sanitizer

Before, `PersistedUsageEntry` has only one `provider`, `model`, `usageStatus`, and
optional `usage`/`totalTokens` (`src/usage/log.ts:9-29`); no child-attempt field exists.
After, keep those parent fields and add the following canonical child shape.

Add:

```ts
export type AttemptRecoveryKind =
  | "transient-5xx"
  | "connection-reset"
  | "oauth-401"
  | "key-429"
  | "image-413";

export interface PersistedUsageAttempt {
  ordinal: number;
  provider: string;
  model: string;
  adapter: string;
  status: number;
  durationMs: number;
  sendCount: number;
  recoveryKinds: AttemptRecoveryKind[];
  usageStatus: UsageStatus;
  inputTokenEstimate?: number;
  usage?: OcxUsage;
  totalTokens?: number;
  errorCode?: string;
}
```

Add `attempts?: PersistedUsageAttempt[]` to `PersistedUsageEntry`. Extend
`normalizeUsageEntry` with the explicit mapper below. It copies only canonical fields,
normalizes usage through `normalizeUsageValue`, filters/deduplicates recovery kinds
through a fixed allowlist, and drops malformed/empty attempts. Never spread an attempt:

```ts
const ATTEMPT_RECOVERY_KINDS = new Set<AttemptRecoveryKind>([
  "transient-5xx",
  "connection-reset",
  "oauth-401",
  "key-429",
  "image-413",
]);
const USAGE_STATUSES = new Set<UsageStatus>([
  "reported", "unreported", "unsupported", "estimated",
]);

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeAttemptUsage(raw: unknown): OcxUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  if (!isNonNegativeFiniteNumber(usage.inputTokens)
    || !isNonNegativeFiniteNumber(usage.outputTokens)) return null;
  for (const key of [
    "totalTokens",
    "cachedInputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "reasoningOutputTokens",
  ] as const) {
    if (key in usage && !isNonNegativeFiniteNumber(usage[key])) return null;
  }
  if ("estimated" in usage && typeof usage.estimated !== "boolean") return null;
  return normalizeUsageValue(usage as unknown as OcxUsage) ?? null;
}

function normalizeUsageAttempt(raw: unknown): PersistedUsageAttempt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const attempt = raw as Record<string, unknown>;
  if (typeof attempt.ordinal !== "number" || !Number.isInteger(attempt.ordinal)
    || attempt.ordinal < 1
    || typeof attempt.provider !== "string" || !attempt.provider
    || typeof attempt.model !== "string" || !attempt.model
    || typeof attempt.adapter !== "string" || !attempt.adapter
    || typeof attempt.status !== "number" || !Number.isInteger(attempt.status)
    || attempt.status < 100 || attempt.status > 599
    || typeof attempt.durationMs !== "number" || !Number.isFinite(attempt.durationMs)
    || attempt.durationMs < 0
    || typeof attempt.sendCount !== "number" || !Number.isInteger(attempt.sendCount)
    || attempt.sendCount < 0
    || typeof attempt.usageStatus !== "string"
    || !USAGE_STATUSES.has(attempt.usageStatus as UsageStatus)) {
    return null;
  }
  if ("inputTokenEstimate" in attempt
    && !isNonNegativeFiniteNumber(attempt.inputTokenEstimate)) return null;
  if ("totalTokens" in attempt
    && !isNonNegativeFiniteNumber(attempt.totalTokens)) return null;
  const usage = "usage" in attempt ? normalizeAttemptUsage(attempt.usage) : undefined;
  if ("usage" in attempt && usage === null) return null;
  const recoveryKinds = Array.isArray(attempt.recoveryKinds)
    ? [...new Set(attempt.recoveryKinds.filter(
      (value): value is AttemptRecoveryKind => typeof value === "string"
        && ATTEMPT_RECOVERY_KINDS.has(value as AttemptRecoveryKind),
    ))]
    : [];
  return {
    ordinal: attempt.ordinal as number,
    provider: attempt.provider,
    model: attempt.model,
    adapter: attempt.adapter,
    status: attempt.status,
    durationMs: attempt.durationMs,
    sendCount: attempt.sendCount as number,
    recoveryKinds,
    usageStatus: attempt.usageStatus as UsageStatus,
    ...(isNonNegativeFiniteNumber(attempt.inputTokenEstimate)
      ? { inputTokenEstimate: attempt.inputTokenEstimate }
      : {}),
    ...(usage ? { usage } : {}),
    ...(isNonNegativeFiniteNumber(attempt.totalTokens)
      ? { totalTokens: attempt.totalTokens }
      : {}),
    ...(typeof attempt.errorCode === "string" ? { errorCode: attempt.errorCode } : {}),
  };
}

function normalizedAttempts(raw: unknown): PersistedUsageAttempt[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeUsageAttempt)
    .filter((attempt): attempt is PersistedUsageAttempt => attempt !== null);
}
```

At the start of `normalizeUsageEntry`, compute
`const attempts = normalizedAttempts(entry.attempts)` and add only
`...(attempts.length > 0 ? { attempts } : {})` to the returned object. In
`readUsageEntries`, push `normalizeUsageEntry(parsed)` rather than raw `parsed`, so a
malformed attempt array is ignored locally and forbidden extras never re-enter through
hand-edited JSONL. `normalizeUsageValue` remains a canonical-field copier and is called
only after the runtime guards above; it is not treated as validation. A malformed child
attempt is dropped independently, while the parent row and valid sibling attempts remain
readable and aggregatable. Legacy lines without attempts retain their existing canonical
fields.

### 4.3 `src/server/request-log.ts` — MODIFY — mutable attempt lifecycle and one final parent row

Before, `RequestLogContext` owns one `providerAdapter`, `usage`, and
`usageLogInputTokens`, while `addFinalRequestLog` computes exactly one `finalUsage` from
that mutable final route (`src/server/request-log.ts:23-50,380-390`). After, preserve
those legacy fields and add the attempt lifecycle below.

Import attempt types from `../usage/log`. Extend `RequestLogContext` with internal
fields and public attempt list:

```ts
  attempts?: PersistedUsageAttempt[];
  /** Internal mutable final attempt; omitted from RequestLogEntry/JSONL. */
  activeAttempt?: PersistedUsageAttempt;
  /** Internal wall-clock origin for the committed final attempt; never persisted. */
  activeAttemptStartedAt?: number;
```

Extend `RequestLogEntry` with `attempts?: PersistedUsageAttempt[]` and pass sanitized
attempts to `appendUsageEntry` in `addRequestLog`.

Extract current `addFinalRequestLog` usage logic (`src/server/request-log.ts:380-390`)
into the complete reusable helpers below. `finalizedUsage` deliberately preserves the
current adapter-aware estimate behavior byte-for-byte; attempt helpers mutate the same
attempt object retained by the parent so deferred terminal JSON/SSE inspection can seal
the committed attempt without replacing its identity:

```ts
interface FinalizedUsageResult {
  usage?: OcxUsage;
  status: UsageStatus;
  totalTokens?: number;
}

function finalizedUsage(
  adapter: string,
  usage: OcxUsage | undefined,
  inputTokenEstimate: number | undefined,
): FinalizedUsageResult {
  const estimate = typeof inputTokenEstimate === "number"
    && Number.isFinite(inputTokenEstimate)
    && inputTokenEstimate >= 0
    ? inputTokenEstimate
    : undefined;
  const finalUsage = usageForFinalLog(adapter, usage);
  const usageFallback = !finalUsage && estimate !== undefined
    ? { inputTokens: estimate, outputTokens: 0, estimated: true }
    : undefined;
  const loggedUsage = finalUsage && estimate !== undefined
    ? {
        ...finalUsage,
        inputTokens: Math.max(finalUsage.inputTokens, estimate),
        estimated: true,
      }
    : (finalUsage ?? usageFallback);
  const totalTokens = usageTotalTokens(loggedUsage);
  return {
    status: usageStatusForFinalLog(loggedUsage),
    ...(loggedUsage ? { usage: loggedUsage } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export function beginRequestAttempt(
  ordinal: number,
  provider: string,
  model: string,
  adapter: string,
): PersistedUsageAttempt {
  return {
    ordinal,
    provider,
    model,
    adapter,
    status: 0,
    durationMs: 0,
    sendCount: 0,
    recoveryKinds: [],
    usageStatus: "unreported",
  };
}

export function sealRequestAttemptIdentity(
  attempt: PersistedUsageAttempt | undefined,
  provider: string,
  adapter: string,
): void {
  if (!attempt) return;
  attempt.provider = provider;
  attempt.adapter = adapter;
}

export function noteAttemptSend(
  attempt: PersistedUsageAttempt | undefined,
  inputTokenEstimate: number | undefined,
  recovery?: AttemptRecoveryKind,
): void {
  if (!attempt) return;
  attempt.sendCount += 1;
  if (typeof inputTokenEstimate === "number"
    && Number.isFinite(inputTokenEstimate)
    && inputTokenEstimate >= 0) {
    attempt.inputTokenEstimate = inputTokenEstimate;
  }
  if (recovery && !attempt.recoveryKinds.includes(recovery)) {
    attempt.recoveryKinds.push(recovery);
  }
}

export function finishRequestAttempt(
  attempt: PersistedUsageAttempt,
  status: number,
  durationMs: number,
  usage?: OcxUsage,
): PersistedUsageAttempt {
  const finalized = finalizedUsage(
    attempt.adapter,
    usage ?? attempt.usage,
    attempt.inputTokenEstimate,
  );
  attempt.status = status;
  attempt.durationMs = Math.max(0, durationMs);
  attempt.usageStatus = finalized.status;
  if (finalized.usage) attempt.usage = finalized.usage;
  else delete attempt.usage;
  if (finalized.totalTokens !== undefined) attempt.totalTokens = finalized.totalTokens;
  else delete attempt.totalTokens;
  const errorCode = requestLogErrorCode(status);
  if (errorCode) attempt.errorCode = errorCode;
  else delete attempt.errorCode;
  return attempt;
}

export function aggregateAttemptUsage(
  attempts: readonly PersistedUsageAttempt[],
): FinalizedUsageResult {
  const status: UsageStatus = attempts.length > 0
    && attempts.every(attempt => attempt.usageStatus === "unsupported")
    ? "unsupported"
    : attempts.some(attempt => (
        attempt.usageStatus === "unreported" || attempt.usageStatus === "unsupported"
      ))
      ? "unreported"
      : attempts.some(attempt => attempt.usageStatus === "estimated")
        ? "estimated"
        : attempts.length > 0
          ? "reported"
          : "unreported";

  const usages = attempts.flatMap(attempt => attempt.usage ? [attempt.usage] : []);
  if (usages.length === 0) return { status };

  const sumOptional = (
    key: "cachedInputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens"
      | "reasoningOutputTokens",
  ): number | undefined => {
    const present = usages.flatMap(usage => (
      typeof usage[key] === "number" ? [usage[key] as number] : []
    ));
    return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
  };
  const cachedInputTokens = sumOptional("cachedInputTokens");
  const cacheReadInputTokens = sumOptional("cacheReadInputTokens");
  const cacheCreationInputTokens = sumOptional("cacheCreationInputTokens");
  const reasoningOutputTokens = sumOptional("reasoningOutputTokens");
  const totalTokens = usages.reduce(
    (sum, usage) => sum + (usageTotalTokens(usage) ?? 0),
    0,
  );
  const aggregate: OcxUsage = {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(status === "estimated" ? { estimated: true } : {}),
  };
  return { usage: aggregate, status, totalTokens };
}
```

`noteAttemptSend` increments `sendCount` on every actual proxy-visible send and replaces
the estimate when the rebuilt adapter request provides one. Recovery kinds remain
ordered and unique. `finishRequestAttempt` uses attempt adapter + latest estimate and
sets `errorCode` through `requestLogErrorCode`. `beginRequestAttempt`'s pick target is
provisional: before an attempt is finished or retained, `sealRequestAttemptIdentity`
must overwrite it with the child request's final safe `logCtx.provider` label and actual
adapter name. This is the same account-safe provider identity produced by
`formatCodexProviderForLog`; raw account IDs never enter the attempt.

Update `applyResponseLogMetadata` (`src/server/request-log.ts:172-184`) so extracted
usage writes both `logCtx.usage` and `logCtx.activeAttempt.usage`. Do the same for any
partial `AdapterEvent.error.usage` path. At finalization, finish the active attempt with
the actual terminal HTTP status before building the parent.

For combo rows, aggregate attempts and override logical identity:

```ts
  if (logCtx.activeAttempt) {
    finishRequestAttempt(
      logCtx.activeAttempt,
      status,
      Date.now() - (logCtx.activeAttemptStartedAt ?? start),
      logCtx.usage,
    );
  }
  const existing = finalizedUsage(
    logCtx.providerAdapter ?? logCtx.provider,
    logCtx.usage,
    logCtx.usageLogInputTokens,
  );
  const attempts = logCtx.attempts?.map(attempt => ({ ...attempt }));
  const isCombo = (logCtx.requestedModel ?? "").startsWith("combo/")
    && (attempts?.length ?? 0) > 0;
  const aggregate = isCombo ? aggregateAttemptUsage(attempts ?? []) : null;
  const loggedUsage = aggregate?.usage ?? existing.usage;
  const usageStatus = aggregate?.status ?? existing.status;
  const totalTokens = aggregate?.totalTokens ?? existing.totalTokens;
```

This replaces the old inline `finalUsage`/`usageFallback` block. Then replace the existing
`model`, `provider`, and `usageStatus` lines in the `addLog` object and add the attempt
field with these exact entries; the existing later `loggedUsage` and `totalTokens`
conditional spreads now consume the variables above:

```ts
    model: isCombo ? logCtx.requestedModel! : logCtx.model,
    provider: isCombo ? "combo" : logCtx.provider,
    usageStatus,
    ...(attempts?.length ? { attempts } : {}),
```

`aggregateAttemptUsage` sums canonical usage fields independently: `inputTokens` already
includes cache reads/writes, so cache detail is retained as subset metadata and is never
added to totals. The status branch implements §3.2 exactly, including reported+estimated
→ estimated, any measured+unsupported/unreported → unreported, and all unsupported →
unsupported. Existing non-combo byte shape and tests must remain unchanged.

Extend `filterRequestLogs(provider=...)` so a provider matches either the parent label or
any attempt provider. Status filtering remains parent status.

### 4.4 `src/server/responses.ts` — MODIFY — attach attempts and refresh every rebuild estimate

#### A. Create and retain one attempt per combo target

In 030's `handleComboResponses`, before each child call:

```ts
    const attempt = beginRequestAttempt(
      (logCtx.attempts?.length ?? 0) + 1,
      pick.target.provider,
      pick.target.model,
      config.providers[pick.target.provider]!.adapter,
    );
    childLog.activeAttempt = attempt;
    let attemptRetained = false;

    const retainCancelledAttempt = (): void => {
      if (attemptRetained) return;
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
      );
      finishRequestAttempt(attempt, 499, Date.now() - started, childLog.usage);
      (logCtx.attempts ??= []).push(attempt);
      attemptRetained = true;
    };
```

Initialize the parent logical identity at `handleComboResponses` entry, before the first
pick/child call, so outer `addFinalRequestLog` recognizes cancelled requests as combo
parents and persists their attempts:

```ts
logCtx.requestedModel = `combo/${comboId}`;
logCtx.model = `combo/${comboId}`;
logCtx.provider = "combo";
```

`resolvedModel` remains conditional on a successfully committed child.
The closure above owns cancellation retention for this loop iteration. It seals from the
same safe `childLog.provider` and final adapter fields as ordinary completion, does not set
`logCtx.activeAttempt`, and its boolean guard makes finish/push idempotent within the
iteration.

Invoke `retainCancelledAttempt()` immediately before every cancellation return after the
attempt exists:

```ts
// handleResponses threw because connect/send was aborted.
if (options.abortSignal?.aborted) {
  retainCancelledAttempt();
  return clientCancelledResponse();
}

// A response resolved after the client had already aborted.
if (options.abortSignal?.aborted) {
  callbackGate.discard();
  retainCancelledAttempt();
  return clientCancelledResponse();
}

callbackGate.discard();
if (response.status === 499) {
  retainCancelledAttempt();
  return clientCancelledResponse();
}

// Both the bounded-read catch-abort and the post-read aborted check.
if (options.abortSignal?.aborted) {
  retainCancelledAttempt();
  return clientCancelledResponse();
}
```

The pre-loop `options.abortSignal?.aborted` return at current `responses.ts:568` remains
unchanged because no attempt exists. All five post-begin return sites across the four
cancellation classes at current `responses.ts:601-631` retain status 499 before returning.
None may call
`advanceComboAfterFailure`, emit the combo warning, mutate cooldown/sticky selection,
commit callback publication, or invoke success accounting.

030 already landed `ConsumedComboFailure { response, classificationText, retryAfter?,
usage? }`, sanitized Retry-After handling, both 64 KiB/5 s source-site reads, callback
publication, and callback-first fallback. Do not replace those bodies. The reduced 040
diff imports `usageFromResponsesPayload` and extracts only a canonical usage snapshot
while the landed helper still owns the bounded text:

```diff
+ import { usageFromResponsesPayload } from "./request-log";

+ function usageFromComboFailureText(text: string): OcxUsage | undefined {
+   try {
+     const payload = JSON.parse(text) as Record<string, unknown>;
+     const nested = payload.response;
+     const source = nested && typeof nested === "object" && !Array.isArray(nested)
+       ? nested as Record<string, unknown>
+       : payload;
+     return usageFromResponsesPayload(source.usage);
+   } catch {
+     return undefined;
+   }
+ }

 async function consumeComboFailure(
   response: Response,
   signal?: AbortSignal,
   now = Date.now(),
 ): Promise<ConsumedComboFailure> {
   const fallback = `Provider error ${response.status}`;
   let classificationText = fallback;
+  let usage: OcxUsage | undefined;
   try {
     const body = await readBoundedResponseBody(response, { signal });
+    usage = usageFromComboFailureText(body.text);
     if (body.displaySafe) {
       const safeText = redactSecretString(body.text).slice(0, 500);
       if (safeText) classificationText = safeText;
     }
   } catch (error) {
     if (signal?.aborted) throw error;
     classificationText = fallback;
   }
   const message = classificationText === fallback
     ? fallback
     : `${fallback}: ${classificationText}`;
   const retryAfter = sanitizedRetryAfter(response.headers.get("retry-after"), now);
   return {
     response: formatErrorResponse(response.status, "upstream_error", message),
     classificationText,
     ...(retryAfter !== undefined ? { retryAfter } : {}),
+    ...(usage ? { usage } : {}),
   };
 }
```

The landed call sites at current `responses.ts:1088-1092` and `:1377-1382` remain
unchanged and publish this enriched failure. The outer engine at `:623-627` continues to
prefer `consumedChildFailure`; only its existing fallback invokes the helper. After that
selection, seal and finish the attempt from the response status and `failure.usage`, then
retain it before stop/advance:

```ts
    const failure = consumedChildFailure
      ?? await consumeComboFailure(response, options.abortSignal);
    sealRequestAttemptIdentity(
      attempt,
      childLog.provider,
      childLog.providerAdapter ?? attempt.adapter,
    );
    finishRequestAttempt(
      attempt,
      response.status,
      Date.now() - started,
      failure.usage,
    );
    (logCtx.attempts ??= []).push(attempt);
    attemptRetained = true;
    lastFailure = failure.response;
```

No 040 code passes raw `Retry-After`, adds `.text()`, mutates `childLog.usage` during
failed-body inspection, republishes the callback, or owns a second body read.

On success seal and push the same object, set `logCtx.activeAttempt = attempt` and
`logCtx.activeAttemptStartedAt = started`, then merge child metadata without overwriting
the parent `attempts` array:

```ts
sealRequestAttemptIdentity(
  attempt,
  childLog.provider,
  childLog.providerAdapter ?? attempt.adapter,
);
(logCtx.attempts ??= []).push(attempt);
attemptRetained = true;
logCtx.activeAttempt = attempt;
logCtx.activeAttemptStartedAt = started;
```

Outer deferred JSON/SSE inspection mutates the final object; `addFinalRequestLog` seals
it at terminal before cloning/aggregating attempts.

On committed success, add only the resolved physical identity; logical combo identity was
already set before the child attempt:

```ts
logCtx.resolvedModel = childLog.resolvedModel ?? childLog.model;
```

At current `responses.ts:860`, `childLog.provider` becomes the account-safe
`formatCodexProviderForLog(...)` label. After wire-protocol resolution at current
`:888-891`, set `childLog.providerAdapter = adapter.name` and seal the active attempt;
repeat the idempotent seal immediately before every finish/push as shown above so early
safe failures also cannot retain the provisional pick identity. Never store account IDs
beyond the existing safe provider label contract.

#### B. Instrument actual request builds, including retries

After the current initial ordinary build at `src/server/responses.ts:995`, preserve the
legacy assignment and count immediately before the actual direct `fetchResponse` send:

```ts
  const inputTokenEstimate = typeof request.usageLog?.inputTokens === "number"
    ? request.usageLog.inputTokens
    : undefined;
  if (inputTokenEstimate !== undefined) logCtx.usageLogInputTokens = inputTokenEstimate;

  if (adapter.fetchResponse) {
    noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate);
    upstreamResponse = await adapter.fetchResponse(request, {
      abortSignal: upstream.signal,
      timeoutMs: connectMs,
      stream: parsed.stream,
    });
  }
```

The passthrough branch at current `src/server/responses.ts:741-760` builds its own request
before the ordinary path, so it needs its own estimate and fetch-thunk instrumentation.
Use the retry helper's recovery-aware callback from the next subsection; the first thunk
invocation receives `undefined`, so it records the initial send exactly once at the point
where the combo-created `activeAttempt` is live:

```ts
    const passthroughEstimate = typeof request.usageLog?.inputTokens === "number"
      ? request.usageLog.inputTokens
      : undefined;
    if (passthroughEstimate !== undefined) {
      logCtx.usageLogInputTokens = passthroughEstimate;
    }
    upstreamResponse = await fetchWithTransientRetry(
      recovery => {
        noteAttemptSend(logCtx.activeAttempt, passthroughEstimate, recovery);
        return fetchWithHeaderTimeout(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        }, upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
      },
      { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
    );
```

#### C. `src/lib/upstream-retry.ts` — MODIFY — identify each replayed send

Make the replay reason available to the fetch thunk without changing retry decisions,
delays, or limits:

```ts
export type UpstreamSendRecovery = "connection-reset" | "transient-5xx";
type ReplayableFetch = (recovery?: UpstreamSendRecovery) => Promise<Response>;

export async function fetchWithResetRetry(
  doFetch: ReplayableFetch,
  opts: ResetRetryOptions = {},
  firstRecovery?: UpstreamSendRecovery,
): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? RESET_RETRY_MAX_ATTEMPTS);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.abortSignal?.aborted) throw abortError(opts.abortSignal);
    try {
      return await doFetch(attempt === 0 ? firstRecovery : "connection-reset");
    } catch (err) {
      if (opts.abortSignal?.aborted || !isConnectionResetError(err) || attempt === attempts - 1) throw err;
      lastError = err;
      console.warn(
        `[upstream-retry] connection reset${opts.label ? ` (${opts.label})` : ""} — retrying (${attempt + 2}/${attempts})`,
      );
      await sleepWithAbort(retryBackoffDelayMs(attempt, {
        baseDelayMs: RESET_RETRY_BASE_DELAY_MS,
        maxDelayMs: RESET_RETRY_MAX_DELAY_MS,
      }), opts.abortSignal);
    }
  }
  throw lastError ?? new Error("upstream fetch failed");
}
```

Keep `fetchWithTransientRetry`'s first call as
`fetchWithResetRetry(doFetch, opts)`. Change only its post-5xx replay call to
`fetchWithResetRetry(doFetch, opts, "transient-5xx")`. Existing zero-argument thunks
remain source-compatible; instrumented response thunks receive an exact reason. Its
signature must therefore become
`fetchWithTransientRetry(doFetch: ReplayableFetch, opts: TransientRetryOptions = {})`;
the body and return contract are otherwise unchanged.

Change `rebuildAndRefetch` to accept a recovery kind, and immediately after every
`activeAdapter.buildRequest` call invoke `noteAttemptSend` with the rebuilt request's
fresh estimate. Call it as:

```ts
rebuildAndRefetch("oauth-401")
rebuildAndRefetch("key-429")
rebuildAndRefetch("image-413")
```

Wrap ordinary `fetchWithResetRetry` the same way as passthrough: its thunk calls
`noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate, recovery)` immediately before
the fetch. The first call counts with no recovery kind; each replay has the exact helper-
supplied kind. Do not increment merely for building/parsing a response.

For runTurn and web-search, set `sendCount` to at least one when their execution begins.
Their internal iteration usage remains terminal-aggregated by those adapters/loops; do
not invent inaccessible sub-send counts.

### 4.5 `src/usage/summary.ts` — MODIFY — logical totals, attempt-attributed dimensions

Before, every totals/day/model/provider loop iterates one `PersistedUsageEntry` and
increments `requests` once for its final provider/model (`src/usage/summary.ts:132-160,
167-278`). After, parent totals still iterate once while physical dimensions consume
the attribution view below.

Add `attemptCount` to `UsageSummaryTotals`, `UsageDayModel`, `UsageModel`, and
`UsageProvider`. Top-level `requests` and day `requests` still iterate parent entries
once. `attemptCount` is `entry.attempts?.length ?? 1`.

Add a private attribution adapter:

```ts
interface UsageAttribution {
  requestId: string;
  provider: string;
  model: string;
  usageStatus: UsageStatus;
  usage?: OcxUsage;
  totalTokens?: number;
}

function usageAttributions(entry: PersistedUsageEntry): UsageAttribution[] {
  if (!entry.attempts?.length) {
    return [{
      requestId: entry.requestId,
      provider: entry.provider,
      model: entry.model,
      usageStatus: entry.usageStatus,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
    }];
  }
  return entry.attempts.map(attempt => ({
    requestId: entry.requestId,
    provider: attempt.provider,
    model: attempt.model,
    usageStatus: attempt.usageStatus,
    ...(attempt.usage ? { usage: attempt.usage } : {}),
    ...(attempt.totalTokens !== undefined ? { totalTokens: attempt.totalTokens } : {}),
  }));
}
```

Use parent rows for total requests/coverage/status and aggregate parent usage, avoiding
double-counting. Use `usageAttributions` for provider/model/day-model token dimensions.
For each provider/model/day-model row, group attributions by parent `requestId` before
incrementing any request counter; `attemptCount` alone increments per attribution.

Fold each parent+dimension group's attempt statuses with the same rule as the parent:

- `reported` when every attribution in the group is reported;
- `estimated` when every attribution is measured and at least one is estimated;
- `unsupported` when every attribution is unsupported;
- otherwise `unreported`.

Then `requests` is the number of parent groups, `measuredRequests` counts groups folded
to reported or estimated, `reportedRequests` counts groups folded to reported, and
`estimatedRequests` counts groups folded to estimated. These counters are mutually
consistent and never increment twice because one parent retried the same dimension.
For one parent that touches provider A twice with one estimated attempt and one reported
attempt, provider A reports `requests:1, attemptCount:2, measuredRequests:1,
reportedRequests:0, estimatedRequests:1`. A second fixture with both attempts reported
must yield `requests:1, attemptCount:2, measuredRequests:1, reportedRequests:1,
estimatedRequests:0`. Remove private maps/sets before returning. Legacy entries produce
exactly one attribution and unchanged output except additive `attemptCount:1`.

### 4.6 `tests/codex-catalog.test.ts` — MODIFY — pure capability intersection and gathered rows

Add pure `deriveComboCatalogModel` tests:

```ts
test("combo capabilities are the safe intersection of every member", () => {
  const combo = normalizedCombo({ defaultEffort: "high", targets: [a, b] });
  expect(deriveComboCatalogModel("mixed", combo, [
    { provider: "a", id: "m1", contextWindow: 200_000, maxInputTokens: 180_000,
      inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium", "high"], parallelToolCalls: true },
    { provider: "b", id: "m2", contextWindow: 128_000, maxInputTokens: 100_000,
      inputModalities: ["text"], reasoningEfforts: ["low", "medium"], parallelToolCalls: false },
  ])).toEqual(expect.objectContaining({
    provider: "combo", id: "mixed", contextWindow: 128_000, maxInputTokens: 100_000,
    inputModalities: ["text"], reasoningEfforts: ["low", "medium"],
    defaultReasoningEffort: "medium",
  }));
});
```

Assert no `parallelToolCalls` and no image. Add all-vision, disjoint/empty modalities,
common-high-default, empty reasoning intersection, missing member, missing context,
target order, and duplicate defensive-null cases. Add the wire-clamp edge
`defaultEffort:"low"` with a common ladder
of only `["high"]` and assert `defaultReasoningEffort:"high"`; this proves the lowest
supported rung above the request is selected when no common rung exists at/below it.
Gather integration must prove rows sort deterministically,
`disabledModels:["combo/mixed"]` hides public emission through the existing filter, and
warning dedupe resets through `resetCatalogRuntimeStateForTests()`. Add a missing-member
fixture whose configured model ID contains a token-shaped sentinel (for example
`sk-warning-secret-123456`), spy on `console.warn`, and assert the warning contains
`[REDACTED]` but not the sentinel. This executes `safeCatalogWarningLabel` rather than
merely inspecting its source. Final-output tests must pass the derived combo through
both template/template-free `buildCatalogEntries` and `mergeCatalogEntriesForSync` and
assert no added `max`/`ultra`, no inherited modality, and no row at all for an empty
modality intersection.

Final-sync tests must use the config-derived `exactComboSlugs` set, not hand-classify rows
by `provider`/`owned_by`. Seed an on-disk row in each lifecycle case and assert the merged
result: a zero-combo config with a physical provider named `combo` preserves
`combo/model`; deleting the last configured combo yields an empty exact set and removes
its old `combo/deleted` row; and a still-configured combo whose member no longer resolves
removes its old row because it is absent from the fresh derived set. The deletion case
also activates the management DELETE refresh at `management-api.ts:1434-1447` so the
assertion covers immediate final catalog state, not only a pure merge helper.
Also exercise the live `/v1/models?client_version` caller with the same helper-derived set,
proving its direct `buildCatalogEntries` path preserves exact virtual capabilities while a
zero-combo physical `combo` provider keeps ordinary routed mock-tier behavior.

### 4.7 `tests/request-log.test.ts` — MODIFY — ordered attempts and no non-combo drift

Cover `beginRequestAttempt`, `sealRequestAttemptIdentity`, `noteAttemptSend`,
`finishRequestAttempt`, and `aggregateAttemptUsage` directly and exercise private `finalizedUsage` through
`finishRequestAttempt` plus legacy `addFinalRequestLog`: two attempts A503/B200;
latest-estimate replacement; recovery-kind ordered dedupe; reported+estimated aggregate;
measured+unreported aggregate with partial tokens; all-unsupported aggregate; cache
detail retained but not re-added; active streaming final-attempt update; provider filter
matching an attempt; no attempt matching status-only filters; and byte-for-byte object
equality for a legacy non-combo fixture except the intentionally additive fields (which
must be absent when unused).

### 4.8 `tests/usage-log.test.ts` — MODIFY — persisted sanitizer/backward compatibility

Persist/read ordered attempts with usage/cache fields and recovery kinds. Inject forbidden
runtime extras into both parent and attempt (`headers`, `authorization`, `body`,
`messages`, access/refresh tokens, raw error) and assert none appear in JSONL. Add malformed
attempt array and legacy no-attempt line cases. Add a hand-edited JSONL parent with three
attempts where the middle attempt has, in table-driven subcases, an out-of-range or
fractional status, negative `inputTokenEstimate`/`totalTokens`, or non-numeric required
`usage.inputTokens`/`usage.outputTokens`. The parent and valid first/third siblings must
still read and aggregate; only the malformed middle attempt is dropped.

### 4.9 `tests/usage-summary.test.ts` — MODIFY — no logical inflation, physical attribution

One parent combo request with A estimated 100 input and B reported 10/2 must assert:

- `summary.requests === 1`, `summary.attemptCount === 2`;
- parent token total includes both measured attempts exactly once;
- provider A and B each have `requests:1, attemptCount:1` and their own tokens;
- no synthetic provider `combo` appears in provider token rows;
- same-provider two-target combo with estimated+reported attempts has provider
  `requests:1, attemptCount:2, measuredRequests:1, reportedRequests:0,
  estimatedRequests:1`; an all-reported pair has reported 1 and estimated 0;
- day logical requests stay 1 while day-model rows show both attempts;
- legacy entries retain existing totals and gain only `attemptCount:1`.

### 4.10 `tests/server-combo-failover-e2e.test.ts` — MODIFY — end-to-end attempt receipt

Extend the 030 A503→B200 server case. Consume the final response so deferred logging
finishes, call `/api/logs?tail=1`, and read isolated `usage.jsonl`. Both surfaces must show
ordered attempts `[A503,B200]`, logical parent `provider:"combo"`, physical final
`resolvedModel`, and B's reported usage. Use an estimating adapter fixture for A in a
second case to prove the estimate belongs to A and cannot overwrite B after hop.

Add two distinct failed-body fixtures and exercise them through the full combo engine:

1. ordinary HTTP A returns 503 JSON with an original top-level Responses `usage` object;
2. passthrough JSON A returns 503 JSON with a different original top-level Responses
   `usage` object and `content-type: application/json`.

For each path, use a one-target combo plus a one-shot body fixture with an original-body
read counter and assert the counter is exactly one. Fully consume the returned sanitized
error, then assert A's finished attempt contains the exact path-specific usage from the
original text. Also assert the sanitized failed `Response` has no structured top-level
`usage` field; the persisted value therefore came from the bounded read, not the
wrapper. The passthrough case activates current `responses.ts:1088-1092`; the ordinary
case activates current `:1377-1382`; both must observe the callback-first selection at
`:623-627`. Add non-JSON, oversized, and stalled bounded-read controls whose attempts
remain honestly unreported and whose safe failure envelopes contain no leaked body.

Add a provider-local retry case whose adapter request estimate changes between builds;
assert one target attempt, `sendCount:2`, the expected recovery kind, and the latest
estimate. This specifically closes the stale estimator noted around PR-head
`responses.ts:972/1005`.

Extend the three landed abort activation paths at
`tests/server-combo-failover-e2e.test.ts:753-858`: connect cancellation, failure-body
bounded-read cancellation, and a successful response resolving after abort. Isolate the
usage file, fully await the 499 response and outer request-log finalization, then query
`/api/logs?tail=1` and read the JSONL row. For each path, both surfaces must contain one
retained attempt with `attempts[0].status === 499`, the safe physical provider/model/
adapter identity, and no second attempt. Preserve the landed assertions for no backup,
warning, cooldown, callback publication, or round-robin success accounting. Add a focused
child-status-499 activation if the three fixtures do not directly execute
`response.status === 499`; it must prove the same exactly-once receipt and no failure/
success side effects.

## 5. Conditional-path activation matrix

| Conditional path | Test trigger | Observable proof |
|---|---|---|
| all members resolved | two known member rows | combo row exists |
| member missing | omit one exact provider/model | no combo row; one warning signature |
| context unknown | member context undefined/zero | no combo row; no 128k fallback |
| all vision | every modalities includes image | combo includes image |
| one text-only/unknown modality | one `[text]` or undefined | combo modalities exclude image |
| empty modality intersection | disjoint member modalities | derive returns null and final build/sync emit no combo row; no fabricated text |
| context/max-input intersection | 200k/128k and 180k/100k | 128k/100k exactly |
| reasoning intersection | `[low,medium,high]` vs `[low,medium]` | `[low,medium]` |
| default common | default medium in intersection | medium advertised |
| default incompatible | default high, common to medium | nearest common medium |
| default below every common rung | default low, common `[high]` | lowest supported-above rung high |
| no common reasoning | disjoint/missing ladder | empty efforts, no default |
| final catalog normalization | combo common ladder excludes max/ultra | final `buildCatalogEntries` and sync row preserve the exact ladder/modalities |
| physical `combo` provider | zero configured combos plus `combo/model` routed row | config-derived exact set is empty; physical row is preserved and normalized ordinarily |
| last combo deleted | seed `combo/deleted`, then DELETE its only config row | immediate refresh removes the stale catalog row |
| combo becomes unresolvable | seed prior row, then remove/disable one member | configured slug is absent from fresh derived set and final sync hides it |
| parallel tools all true | both true | combo true |
| one parallel false/undefined | mixed | field absent |
| combo disabled | `disabledModels` contains combo ID | public row filtered |
| warning dedupe/reset | gather twice then reset | one warning, then one after reset |
| first failed attempt | A503 | attempts[0] A/status503 |
| connect cancellation | abort while A connect/send is pending | `/api/logs` and JSONL retain exactly one A attempt with status499; no B/warning/cooldown |
| failure-body cancellation | abort while A's bounded failure body is being read | both log surfaces retain exactly one A status499 attempt; body canceled once; no B/cooldown |
| response-after-abort | A resolves 200 only after abort | both log surfaces retain exactly one A status499 attempt; no success/callback/round-robin accounting |
| direct child 499 | child response reaches the status-499 branch | attempt is sealed/finished/pushed once; no backup or failure/success side effect |
| ordinary failed-body usage | ordinary A503 original JSON includes usage | bounded call at `responses.ts:1377-1382` reads once; callback-first A retains exact usage; wrapper has none |
| passthrough JSON failed-body usage | passthrough A503 original JSON includes distinct usage | bounded call at `responses.ts:1088-1092` reads once; callback-first A retains exact usage |
| bounded failure control | non-JSON/oversized/stalled body | one bounded attempt; usage unreported; safe envelope leaks no body |
| final successful attempt | B200 with usage | attempts[1] B/reported usage |
| adapter estimate | failed estimating target | estimate attached only to that target |
| provider-local rebuild | changing estimate on retry | sendCount2, latest estimate, recovery kind |
| streaming terminal | B commits then response.failed | B attempt terminal status updated; no C attempt |
| mixed measurement | A estimated, B reported | parent estimated when all measured |
| partial unreported | A no measurement, B reported | parent unreported with partial tokens retained |
| all reported | both report | parent reported |
| legacy usage line | no attempts property | unchanged read/summary, attemptCount1 |
| provider filter | parent combo, attempt provider A | `/api/logs?provider=A` includes row |
| sanitizer | secrets in attempt extras | JSONL contains none |
| malformed persisted attempt | hand-edited JSONL has invalid status/token/usage values between two valid attempts | parent and valid siblings aggregate; only malformed attempt is dropped |
| sealed attempt identity | Codex pool child resolves a safe account label and final wire adapter | attempt provider equals `formatCodexProviderForLog` output, adapter equals final adapter, no account ID |
| logical request count | one parent/two attempts | total requests1, attemptCount2 |
| same provider twice | one parent, A estimated then A reported | provider requests1, attemptCount2, measured1, reported0, estimated1 |
| same provider twice all reported | one parent, two reported A attempts | provider requests1, attemptCount2, measured1, reported1, estimated0 |

## 6. Commit plan and attribution

Estimated commit count: **3**.

1. `fix(combos): derive catalog capabilities from every member`
   - Author `bitkyc08-arch <bitkyc08@gmail.com>` + exact Wibias co-author trailer above.
   - Pure intersection helper, config-owned exact slug identity, stale-row lifecycle,
     gather integration, warning/reset, catalog tests.
   - Body cites PR #147 P2 catalog finding and post-review defaultEffort delta.
2. `feat(combos): persist ordered provider attempt attribution`
   - Author `bitkyc08-arch <bitkyc08@gmail.com>` + exact Wibias co-author trailer above.
   - Request/usage attempt shapes, cancellation receipts, response and retry-helper send
     instrumentation,
     original-consumption usage snapshots, bounded untouched-body fallback, summary
     attribution.
   - Body cites PR #147 P2 usage finding and current estimator/retry lines.
3. `test(combos): prove catalog and usage closeout end to end`
   - Author `bitkyc08-arch <bitkyc08@gmail.com>` + exact Wibias co-author trailer above.
   - Sanitizer, summary, catalog, and server receipt tests only.

## 7. Verification gates

Focused:

```bash
bun test --isolate \
  tests/combos.test.ts \
  tests/codex-catalog.test.ts \
  tests/selected-models.test.ts \
  tests/request-log.test.ts \
  tests/usage-log.test.ts \
  tests/usage-summary.test.ts \
  tests/usage-shape-extraction.test.ts \
  tests/usage-provider-label.test.ts \
  tests/server-combo-failover-e2e.test.ts
bun run typecheck
```

Full 040 tip / stack close:

```bash
bun test --isolate ./tests/
bun run privacy:scan
bun run typecheck
git diff --check
```

Targeted static receipts:

```bash
rg -n "defaultReasoningLevel" src/codex/catalog.ts src/combos
rg -n -U 'provider: "combo"[\s\S]{0,300}contextWindow: 128_?000' src/codex/catalog.ts
rg -n "attempts|attemptCount|noteAttemptSend" \
  src/server/request-log.ts src/server/responses.ts src/lib/upstream-retry.ts \
  src/usage/log.ts src/usage/summary.ts
rg -n "exactComboSlugs|hasPhysicalComboProvider|retainCancelledAttempt" \
  src/codex/catalog.ts src/server/responses.ts
git diff --name-only HEAD~3..HEAD
git diff --stat dev...HEAD
```

The first command must not reveal a combo fallback or conflicting field (unrelated
existing test constants are outside the scanned source). The changed-file list is
limited to §4. The full stack diff must contain no binary flowchart copied from PR #147.

## 8. Rollback

Revert commits in reverse order. Removing 040 returns to 030 runtime behavior: combos
still route/fail over safely but public catalog rows and attempt attribution disappear.
Existing JSONL lines with additive `attempts` remain parseable by the pre-040 reader,
which ignores unknown properties; no file rewrite is needed. Do not truncate usage logs.

If only catalog derivation must be disabled, revert commit 1 and refresh the catalog;
do not restore PR's fabricated combo rows. If attempt logging fails, request execution
must remain non-fatal under the existing request-log try/catch; revert observability
commits rather than changing routing.

## 9. Findings closure

| Finding | Closure in 040 | Proof |
|---|---|---|
| P2 catalog fabricates combo capabilities | exact member lookup, modality/reasoning intersection, min context/max input, all-member parallel flag, hide on unknown | pure catalog matrix + gather/filter/warning tests |
| P2 usage records only final provider and stale estimator | ordered sanitized attempts, estimate refreshed on every rebuild, parent aggregate, attempt-attributed summaries, and original-body usage captured at the real ordinary/passthrough consumption sites | request-log/JSONL/summary tests, A503→B200 receipt, and two one-read failed-body E2Es |
| post-review defaultEffort catalog advertisement | reuse current `defaultReasoningEffort`; advertise only a common effective rung using live wire-clamp order | default common/incompatible/below-all/empty-intersection tests |
| Round 6 combo identity/stale lifecycle | config-derived exact slug set is passed to build and sync; absent physical provider makes `combo/` managed against the fresh derived set | physical-provider preservation, last-delete refresh removal, and resolvable→unresolvable final-sync tests |
| Round 6 cancelled attempts vanish | every post-begin cancellation exit safely seals and retains status499 exactly once without routing/accounting side effects | three landed abort-path `/api/logs` + JSONL receipts and direct child-499 activation when needed |

## 10. Stack close gate

040 and the 020→030→040 stack are complete only when:

1. every advertised combo context/modality/reasoning/default can be supported after a
   hop to any member;
2. unresolved capability never becomes a synthetic 128k/text-only combo row;
3. stale virtual `combo/*` rows are retired on delete/unresolvable refresh while a legal
   physical `combo` provider remains untouched;
4. one logical combo request remains one top-level request while all physical attempts
   are visible, ordered, provider-attributed, and secret-free;
5. every child cancellation after attempt creation is retained once with status 499 and
   causes no backup, warning, cooldown, callback, or success accounting;
6. provider-local retries refresh the estimator without creating fake combo targets;
7. ordinary and passthrough JSON failed-attempt usage comes from each path's original
   text, with no post-consumption read of a reconstructed wrapper;
8. legacy usage rows and all non-combo request logs remain compatible;
9. focused/full/typecheck/privacy/diff gates pass at the 040 tip.

## Audit fold-back 2026-07-18

- Blocker 6: replaced warning/sanitizer prose and the legacy attribution placeholder
  with complete current-dev implementations, including warning-label redaction,
  canonical attempt allowlisting, malformed-array isolation, and a real legacy row.
- Blocker 7: no 040 attribution split will be required because all three planned 040
  commits will be maintainer-authored with the exact Wibias co-author trailer; this audit
  result is recorded explicitly rather than changing correct attribution.
- Rebuttal: none; the applicable audit blockers were accepted as stated.

### Round 2

- R2 (HIGH): replaced the four bodyless attempt declarations and missing aggregate with
  complete implementations against current `request-log.ts`/`usage/log.ts`; wired parent
  aggregate usage/status/totals, exact passthrough initial/retry send counting, and direct
  helper tests. Its initial failed-body design assumed every original body reached 030's
  bounded outer consumer; Round 3 corrects that assumption for paths that consume first.
- R3 (MEDIUM): aligned `effectiveComboDefault` with the live wire clamp—highest common
  rung at/below the request, otherwise lowest supported rung above—and added the
  `default=low`, `common=[high]` activation.

### Round 3

- R3 (HIGH): moved failed-attempt usage capture to the real original-text owners.
  Ordinary HTTP inspects `errorText` at the existing final-wrapper site; passthrough JSON
  reuses its already-read text and existing inspection. Both publish a
  `ConsumedComboFailure` through `onConsumedComboFailure`, and the outer engine performs
  its bounded fallback only for a still-untouched body. No path re-reads a consumed body
  or reparses a reconstructed wrapper.
- E2E activation (HIGH): added separate one-target ordinary and passthrough JSON 503
  cases with distinct original usage objects, one-shot read counters, sanitized wrappers
  without structured usage, and exact attempt-usage assertions, plus an untouched
  non-JSON/oversized unreported control.
- Cross-doc interface sync (HIGH): 030 now additively declares
  `ConsumedComboFailure.usage?: OcxUsage` and the internal-only
  `HandleResponsesOptions.onConsumedComboFailure` callback. This is the only 030
  interface expansion required by 040 and is recorded in both Round 3 changelogs.

### Pre-build fold-back round 4 (2026-07-18)

- Cross-doc scope shift (supersedes §3.2 and §4.4A body-read ownership prose): 030 now
  owns the 64 KiB/5 s reads at both ordinary and passthrough JSON original-body sites,
  sanitized Retry-After handoff, `ConsumedComboFailure` creation, and the internal
  callback. 040 only adds `usage?: OcxUsage` by inspecting the text retained by those
  same bounded reads; it must not retain/restore unbounded `.text()` or add another read.

### Pre-build fold-back round 5 (2026-07-18)

- Final catalog output (HIGH): empty modality intersections now hide the combo, and
  explicit exact-capability guards bypass mock max/ultra expansion in
  `buildCatalogEntries` and max re-add/default modality repair in sync. Verification now
  targets final build and merge outputs, not only pure derivation.
- Landed 030 usage ownership (HIGH): replaced stale §3.2/§4.4A unbounded-read and duplicate
  callback bodies with the reduced diff that extracts only `failure.usage` inside the
  landed bounded consumer. Updated E2E activation anchors to current
  `responses.ts:623-627,1088-1092,1377-1382`.
- Persisted attempt validation (HIGH): added runtime guards for HTTP status, estimates,
  totals, and required usage token values, plus malformed-middle-attempt isolation that
  preserves the parent and valid siblings.
- Attempt identity and metrics (MEDIUM): provisional pick identity is sealed from the
  child log's final safe provider/adapter metadata, and provider/model request coverage
  counters now fold once per parent+dimension group. The same-provider retry matrix fixes
  exact measured/reported/estimated outcomes; the commit-attribution note is future tense.

### Pre-build fold-back round 6 (2026-07-18)

- Combo catalog identity and stale-row lifecycle (HIGH): replaced the
  `provider === "combo" && owned_by === "combo"` classifier with the authoritative
  config-derived `exactComboSlugs` set passed through both `buildCatalogEntries` and sync.
  When no physical `combo` provider exists, final sync now owns the namespace against the
  fresh derived set, removing rows after last-combo deletion or resolvable→unresolvable
  transitions; a legal zero-combo physical provider remains preserved. Added all three
  final-sync lifecycle activations.
- Cancelled attempts unrecorded (HIGH): every post-begin cancellation exit now seals safe
  attempt identity and finishes/pushes exactly once with status 499, while retaining the
  landed prohibition on backup, warning, cooldown, callback publication, and success
  accounting. The three existing abort activation paths now require matching
  `/api/logs` and JSONL `attempts[0].status === 499` receipts.
