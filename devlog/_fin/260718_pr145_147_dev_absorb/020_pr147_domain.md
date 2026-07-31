# 020 — PR #147 domain slice on `dev`: validated combos and deterministic selection domain

## 1. Scope and locked inputs

This slice rebuilds the domain/config/management/routing half of community PR #147
from immutable source head `6824e7bc56f5d0b1fc6fbb6089797a951ecb4eda`
(`codex/source-pr147-6824e7bc`) on the tip of 010. The target is local `dev`, **not
`main`**. It must land before 030 and 040, and its tip must be green without either
later slice.

The source head contains reviewed head `a4abda10` plus one later contributor commit,
`6824e7bc feat(combos): defaultEffort fills missing client reasoning`. This slice
absorbs that delta's type, validation, normalization, and pure default-selection
contract. Actual request-body application is deferred to 030 because it must run from
an immutable client body and be re-evaluated with each target's effort policy. Catalog
advertisement is deferred to 040 because it must use member-intersection capabilities.

Attribution follows `000_plan.md`:

- only source-faithful namespace/type primitives reconstructed without redesign: author
  `Wibias <37517432+Wibias@users.noreply.github.com>`, maintainer committer;
- narrowed effort types, strict normalization, deterministic weighted round-robin,
  validation parity, runtime eligibility, deletion guard, and API hardening: maintainer author
  `bitkyc08-arch <bitkyc08@gmail.com>` plus
  `Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`;
- every commit body names PR #147, source head `6824e7bc56f5d0b1fc6fbb6089797a951ecb4eda`,
  and reviewed head `a4abda10` where relevant.

### Exclusions

- No response execution, retry, OAuth, adapter, vision, or web-search change; 030 owns it.
  The only response-surface hook in 020 is the typed `combo_unavailable` mapping for a
  domain selection failure, so an all-disabled persisted combo fails closed instead of
  being reported as an unknown model.
- No catalog row or usage-log shape change; 040 owns it.
- No GUI/i18n work, release, push, GitHub write, or source-ref rewrite.
- Do not persist runtime cursor/cooldown state. A process restart intentionally resets it.
- Do not validate target model IDs against a live `/models` response. Provider/model
  discovery can be stale or unavailable; this slice validates the provider boundary and
  nonblank wire model ID only.

## 2. Current-`dev` evidence and conflict decisions

Required source comparison:

```bash
git diff dev...codex/source-pr147-6824e7bc -- \
  src/combos src/types.ts src/config.ts src/router.ts \
  src/server/management-api.ts tests/combos.test.ts
git show --stat --oneline 6824e7bc
git show 6824e7bc -- src/config.ts src/server/responses.ts src/types.ts \
  src/codex/catalog.ts src/combos tests/combos.test.ts
```

Current `dev` has no `src/combos/` directory and no combo types. Relevant owners are:

- `src/router.ts:190-248`: exported `RouteResult`, canonical OpenAI tier routing,
  disabled-provider checks, and default-provider fallback;
- `src/config.ts:289-443`: provider schema plus current SSRF/header/model-cap/account-mode
  validation;
- `src/server/management-api.ts:417-455`: provider creation;
- `src/server/management-api.ts:643-654`: provider deletion;
- `src/types.ts:430-476`: current `OcxConfig` tail.

PR #147 was based before the landed PR #139/#140 rebuild. Its `router.ts` hunk would
drop current `codexAccountMode`, `routeResult()`, legacy-provider rejection, canonical
OpenAI routing, and registry merge behavior if copied as a whole. Its `config.ts` hunk
duplicates only part of API validation and omits `stickyLimit`, target field, weight,
provider-existence, disabled-provider, and duplicate-target checks. Therefore all
hunks in this slice are re-derived against current `dev`; no file-level checkout or
direct cherry-pick is allowed.

The post-review `defaultEffort` delta also conflicts semantically with current `dev`:

- PR type is an unconstrained `string`; final type is a literal union.
- PR normalization silently converts malformed persisted values to `medium`; final
  persisted-config validation rejects them exactly like the management API.
- PR `applyComboDefaultEffort()` mutates one parsed request before target-specific
  safety is known. 020 exposes only a pure `comboDefaultEffort()` value; 030 owns the
  raw-body application.
- PR catalog field `defaultReasoningLevel` conflicts with current
  `CatalogModel.defaultReasoningEffort` (`src/codex/catalog.ts:292-305`); 040 reuses the
  current name instead of adding an alias.

## 3. Final domain contract

### 3.1 IDs, normalization, and validation

1. Public model IDs are `combo/<id>`. An ID matches
   `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and an empty suffix is never a combo.
   `combo/` is a reserved virtual-model namespace going forward.
2. A combo has at least one target. Every target has a nonblank configured provider,
   nonblank model, integer weight `1..10000`, and unique `provider/model` key.
3. `strategy` defaults to `failover`; `stickyLimit` defaults to 1 and is an integer
   `1..100`; target weight defaults to 1; `defaultEffort` defaults to `medium` and is
   one of `low|medium|high|xhigh|max|ultra`.
4. The one validator in `src/combos/types.ts` serves both persisted config and
   PUT-upsert API, with one explicit mutation-policy option. Persisted config permits configured
   providers whose current state is `disabled:true`; this is a valid degraded runtime
   state created by provider PATCH and must survive restart. Combo PUT-upsert permits a
   mixture of enabled and disabled configured members but rejects a combo whose enabled
   member count is zero. The config schema emits all structured issues; the API returns
   the first issue. Normalization runs only after zero validation issues and never heals
   invalid input.
5. Missing providers remain invalid in both persisted config and PUT-upsert, and provider
   DELETE remains 409-guarded while any combo references it. Routing skips disabled
   members at selection time. If every member is disabled, routing throws
   `NoAvailableComboTargetsError` with wire code `combo_unavailable`; the literal model
   can never fall through to `defaultProvider`. A missing member can arise only from
   unsupported direct in-memory mutation/corruption and is handled by the same
   eligibility guard as defense in depth.
6. Deleting a provider referenced by any combo returns HTTP 409 with sorted dependent
   combo IDs. The user must update/delete those combos first.
7. Namespace precedence is explicit and validation-owned. A physical provider literally
   named `combo` remains valid and routes `combo/<model>` exactly as current `dev` does
   while no combos are configured. As soon as at least one combo is configured (including
   a PUT-upsert candidate), validation rejects that provider with an error naming the
   reserved `combo/` collision. Validation also rejects any combo whose ID equals an
   existing physical provider name, with both colliding names in the error. No router
   ordering is allowed to choose silently between the two meanings.
8. Combo management exposes GET, PUT-upsert, and DELETE only. POST and PATCH are not
   provided for combos: PUT intentionally mirrors config-style whole-value replacement
   for both creation and update, avoiding a second partial-update contract.

### 3.2 Selection semantics

`failover` is ordered: every new request starts at target index 0 and selects the first
eligible, non-excluded target. 030 adds cooldown eligibility and advances through this
same ordered list after failures.

**020-tip activation boundary:** this slice intentionally does not modify response
execution, so production routing calls `pickComboTarget` but has no production
`noteComboSuccess` call yet. A round-robin combo therefore keeps its first active target
(static/pinned selection) at the green 020 tip. The SWRR transition contract below is
fully unit-tested by explicit success notifications, but becomes production-active only
when 030's outer combo orchestrator calls `noteComboSuccess` at its per-adapter commit
boundary. `tests/router.test.ts` must separately assert the honest 020-tip pinned behavior.

`round-robin` is deterministic smooth weighted round-robin (SWRR), not random:

- equal weights produce `A,B,C,A,B,C,...`;
- weights `A=2,B=1` produce selection batches `A,B,A,A,B,A,...`;
- `stickyLimit=N` repeats each selected batch target until **N successful requests**
  have completed; failures do not count and 030 clears a failed sticky target before
  choosing another;
- ties use config order; no `Math.random()` is permitted;
- SWRR current weights survive successful rotation but are process-local and are reset
  by combo PUT/DELETE or `clearComboSelectionState()`.

For `A=2,B=1,stickyLimit=2`, the observable successful request sequence is
`A,A,B,B,A,A,A,A,B,B,A,A,...`. Weight applies to sticky batches, not individual
requests. This explicit definition removes the PR's weighted-random behavior and its
tautological `picks.size >= 1` test.

### 3.3 `defaultEffort` split from `6824e7bc`

020 stores and returns the normalized default and exposes
`comboDefaultEffort(config, id)`. It does **not** mutate `OcxParsedRequest`. In 030 the
combo orchestrator applies the default to a fresh raw JSON clone only when `reasoning`
is absent or is an object without its own `effort`; `reasoning:null` and owned effort
values are preserved. Each concrete target then applies its normal supported-ladder
handling. In 040 the catalog advertises a default only when it belongs to the members'
common reasoning intersection.

## 4. Diff-level implementation

All before snippets are from current `dev`. All after snippets are the required 020 tip.

### 4.1 `src/types.ts` — MODIFY — source shape then maintainer-narrowed final types

Before (`OcxConfig` ends after `upstreamFailoverThreshold`):

```ts
  /** Consecutive non-2xx upstream responses before switching future new threads. Default 3. 0 = disabled. */
  upstreamFailoverThreshold?: number;
  /** Background proactive token refresh ("Token Guardian"). Off by default; see OcxTokenGuardianConfig. */
  tokenGuardian?: OcxTokenGuardianConfig;
```

After:

```ts
  /** Consecutive non-2xx upstream responses before switching future new threads. Default 3. 0 = disabled. */
  upstreamFailoverThreshold?: number;
  /** Virtual `combo/<id>` models spanning concrete provider/model targets (issue #133). */
  combos?: Record<string, OcxComboConfig>;
  /** Background proactive token refresh ("Token Guardian"). Off by default; see OcxTokenGuardianConfig. */
  tokenGuardian?: OcxTokenGuardianConfig;
```

Insert immediately after `OcxConfig`:

```ts
export type OcxComboStrategy = "failover" | "round-robin";
export type OcxComboDefaultEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface OcxComboTarget {
  provider: string;
  model: string;
  /** Relative SWRR batch weight. Default 1; valid range 1..10000. */
  weight?: number;
}

export interface OcxComboConfig {
  targets: OcxComboTarget[];
  /** Ordered failover (default) or deterministic smooth weighted round-robin. */
  strategy?: OcxComboStrategy;
  /** Successful requests retained on one RR selection batch. Default 1; range 1..100. */
  stickyLimit?: number;
  /** Used only when the client omits reasoning.effort. Default medium. */
  defaultEffort?: OcxComboDefaultEffort;
}
```

The snippet is the 020-tip result. Commit 1 may reconstruct the source PR's
`defaultEffort?: string` shape; commit 2, authored by the maintainer with the Wibias
co-author trailer, introduces `OcxComboDefaultEffort` and narrows the field to the final
union shown here.

Do not add a second effort ladder constant to `src/types.ts`; runtime validation reuses
`isCodexReasoningEffort` from `src/reasoning-effort.ts`.

### 4.2 `src/combos/types.ts` — NEW — sole combo schema/normalization owner

Create the file with these public contracts (helper implementations can be adjacent,
but no dependency on `src/config.ts`, avoiding an ESM config↔combos cycle):

```ts
import { isCodexReasoningEffort } from "../reasoning-effort";
import type {
  OcxComboConfig,
  OcxComboDefaultEffort,
  OcxComboStrategy,
  OcxComboTarget,
  OcxProviderConfig,
} from "../types";

export const COMBO_NAMESPACE = "combo";
export const COMBO_DEFAULT_EFFORT: OcxComboDefaultEffort = "medium";
const COMBO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ComboValidationIssue {
  path: Array<string | number>;
  message: string;
}

export interface NormalizedComboConfig {
  strategy: OcxComboStrategy;
  stickyLimit: number;
  defaultEffort: OcxComboDefaultEffort;
  targets: Array<Required<OcxComboTarget>>;
}

export function targetKey(target: Pick<OcxComboTarget, "provider" | "model">): string {
  return `${target.provider}/${target.model}`;
}

export function parseComboModelId(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || modelId.slice(0, slash) !== COMBO_NAMESPACE) return null;
  const id = modelId.slice(slash + 1);
  return id.length > 0 ? id : null;
}

export function comboModelId(id: string): string {
  return `${COMBO_NAMESPACE}/${id}`;
}

export function comboConfigIssues(
  id: string,
  raw: unknown,
  providers: Record<string, OcxProviderConfig>,
  options: { requireEnabledTarget?: boolean } = {},
): ComboValidationIssue[] {
  const issues: ComboValidationIssue[] = [];
  if (!isValidComboId(id)) {
    issues.push({
      path: [],
      message: "combo id must start with a letter/number and use letters, numbers, dot, underscore, or hyphen (max 64)",
    });
  }
  if (Object.prototype.hasOwnProperty.call(providers, COMBO_NAMESPACE)) {
    issues.push({
      path: [],
      message: 'provider name "combo" collides with the reserved "combo/" namespace while combos are configured',
    });
  }
  if (Object.prototype.hasOwnProperty.call(providers, id)) {
    issues.push({
      path: [],
      message: `combo id "${id}" collides with configured provider name "${id}"`,
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path: [], message: "combo must be an object" });
    return issues;
  }

  const body = raw as Record<string, unknown>;
  if (body.strategy !== undefined
    && body.strategy !== "failover"
    && body.strategy !== "round-robin") {
    issues.push({ path: ["strategy"], message: 'strategy must be "failover" or "round-robin"' });
  }
  if (body.stickyLimit !== undefined
    && (typeof body.stickyLimit !== "number" || !Number.isInteger(body.stickyLimit)
      || body.stickyLimit < 1
      || (body.stickyLimit as number) > 100)) {
    issues.push({ path: ["stickyLimit"], message: "stickyLimit must be an integer from 1 to 100" });
  }
  if (body.defaultEffort !== undefined
    && (typeof body.defaultEffort !== "string" || !isCodexReasoningEffort(body.defaultEffort))) {
    issues.push({
      path: ["defaultEffort"],
      message: "defaultEffort must be one of: low, medium, high, xhigh, max, ultra",
    });
  }

  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    issues.push({ path: ["targets"], message: "targets must be a non-empty array" });
    return issues;
  }

  const seen = new Set<string>();
  let configuredProviderCount = 0;
  let enabledProviderCount = 0;
  for (let i = 0; i < body.targets.length; i++) {
    const rawTarget = body.targets[i];
    if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
      issues.push({ path: ["targets", i], message: `targets[${i}] must be an object` });
      continue;
    }
    const target = rawTarget as Record<string, unknown>;
    const provider = typeof target.provider === "string" ? target.provider.trim() : "";
    const model = typeof target.model === "string" ? target.model.trim() : "";

    if (!provider) {
      issues.push({ path: ["targets", i, "provider"], message: `targets[${i}].provider is required` });
    } else if (!Object.prototype.hasOwnProperty.call(providers, provider)) {
      issues.push({
        path: ["targets", i, "provider"],
        message: `targets[${i}].provider "${provider}" is not configured`,
      });
    } else {
      configuredProviderCount += 1;
      if (providers[provider]?.disabled !== true) enabledProviderCount += 1;
    }

    if (!model) {
      issues.push({ path: ["targets", i, "model"], message: `targets[${i}].model is required` });
    }
    if (target.weight !== undefined
      && (typeof target.weight !== "number" || !Number.isInteger(target.weight)
        || target.weight < 1
        || (target.weight as number) > 10_000)) {
      issues.push({
        path: ["targets", i, "weight"],
        message: `targets[${i}].weight must be an integer from 1 to 10000`,
      });
    }

    if (provider && model) {
      const key = targetKey({ provider, model });
      if (seen.has(key)) {
        issues.push({ path: ["targets", i], message: `duplicate combo target "${key}"` });
      } else {
        seen.add(key);
      }
    }
  }
  if (options.requireEnabledTarget
    && configuredProviderCount === body.targets.length
    && enabledProviderCount === 0) {
    issues.push({
      path: ["targets"],
      message: "targets must include at least one enabled provider",
    });
  }
  return issues;
}

export function comboConfigError(
  id: string,
  raw: unknown,
  providers: Record<string, OcxProviderConfig>,
  options: { requireEnabledTarget?: boolean } = {},
): string | null {
  return comboConfigIssues(id, raw, providers, options)[0]?.message ?? null;
}

export function normalizeComboConfig(raw: OcxComboConfig): NormalizedComboConfig {
  return {
    strategy: raw.strategy ?? "failover",
    stickyLimit: raw.stickyLimit ?? 1,
    defaultEffort: raw.defaultEffort ?? COMBO_DEFAULT_EFFORT,
    targets: raw.targets.map(target => ({
      provider: target.provider.trim(),
      model: target.model.trim(),
      weight: target.weight ?? 1,
    })),
  };
}

export function comboDefaultEffort(
  config: { combos?: Record<string, OcxComboConfig> },
  id: string,
): OcxComboDefaultEffort | null {
  const combos = config.combos;
  if (!combos || !Object.prototype.hasOwnProperty.call(combos, id)) return null;
  const value: unknown = combos[id]!.defaultEffort ?? COMBO_DEFAULT_EFFORT;
  return typeof value === "string" && isCodexReasoningEffort(value)
    ? value as OcxComboDefaultEffort
    : null;
}

export function isValidComboId(id: string): boolean {
  return COMBO_ID_PATTERN.test(id);
}

export function listComboIds(config: { combos?: Record<string, OcxComboConfig> }): string[] {
  return Object.keys(config.combos ?? {}).sort((a, b) => a.localeCompare(b));
}

export function getCombo(
  config: { combos?: Record<string, OcxComboConfig> },
  id: string,
): NormalizedComboConfig | undefined {
  const combos = config.combos;
  if (!combos || !Object.prototype.hasOwnProperty.call(combos, id)) return undefined;
  return normalizeComboConfig(combos[id]!);
}
```

The snippet is the final 020-tip parser behavior: `parseComboModelId` deliberately does
not trim the wire suffix, so whitespace cannot alias a configured ID. The contributor
source parser at `6824e7bc:src/combos/types.ts` did call `.trim()`. Commit 1 reconstructs
that source-faithful trim behavior; commit 2, authored by the maintainer with the exact
Wibias co-author trailer, removes the trim and updates the parser tests. The behavior
change must not be attributed to the Wibias-authored source-faithful commit.

The complete `comboConfigIssues` body above must enforce this exact matrix and paths:

| Input | Issue path | Message requirement |
|---|---|---|
| invalid id | `[]` | combo id grammar/max 64 |
| physical provider named `combo` while a combo is configured | `[]` | reserved `combo/` namespace collision naming `combo` |
| combo ID equals a configured provider name | `[]` | collision naming the combo ID/provider name |
| non-object combo | `[]` | `combo must be an object` |
| bad strategy | `["strategy"]` | allowed values |
| non-integer/out-of-range sticky | `["stickyLimit"]` | integer 1..100 |
| bad default effort | `["defaultEffort"]` | full effort list |
| empty/non-array targets | `["targets"]` | non-empty array |
| non-object target | `["targets", i]` | object required |
| blank/non-string provider/model | field path | required/nonblank |
| provider not own property | provider path | not configured |
| all configured providers disabled + `requireEnabledTarget` | `["targets"]` | at least one enabled provider |
| bad weight | weight path | integer 1..10000 |
| duplicate normalized key | `["targets", i]` | duplicate `provider/model` |

`comboConfigIssues` must not normalize bad values. In particular `1.5`, `0`, `101`,
`NaN`, and `Infinity` are rejected rather than truncated/clamped. With the default
options used by persisted config, disabled members—including an all-disabled combo—are
valid. Only the PUT-upsert caller sets `requireEnabledTarget:true`.

### 4.3 `src/combos/resolve.ts` — NEW — deterministic selection and fail-closed eligibility

Use one state map per combo and smooth weighted selection:

```ts
import type { OcxComboTarget, OcxConfig } from "../types";
import { getCombo, parseComboModelId, targetKey } from "./types";
import type { NormalizedComboConfig } from "./types";

export interface ComboPick {
  comboId: string;
  target: Required<OcxComboTarget>;
  targetIndex: number;
  attempted: string[];
}

interface SelectionState {
  activeKey?: string;
  successes: number;
  currentWeights: Map<string, number>;
}

const selectionState = new Map<string, SelectionState>();

function targetProviderIsUsable(config: OcxConfig, target: OcxComboTarget): boolean {
  return Object.prototype.hasOwnProperty.call(config.providers, target.provider)
    && config.providers[target.provider]?.disabled !== true;
}

function smoothWeightedIndex(
  targets: Required<OcxComboTarget>[],
  state: SelectionState,
  eligible: (target: Required<OcxComboTarget>) => boolean,
): number {
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    if (!eligible(target)) continue;
    const key = targetKey(target);
    const score = (state.currentWeights.get(key) ?? 0) + target.weight;
    state.currentWeights.set(key, score);
    total += target.weight;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  if (best >= 0) {
    const key = targetKey(targets[best]!);
    state.currentWeights.set(key, (state.currentWeights.get(key) ?? 0) - total);
  }
  return best;
}
```

Public behavior:

```ts
export function pickComboTarget(
  config: OcxConfig,
  comboId: string,
  options: {
    exclude?: Iterable<string>;
    eligible?: (target: Required<OcxComboTarget>) => boolean;
  } = {},
): ComboPick | null;

export function noteComboSuccess(
  comboId: string,
  combo: NormalizedComboConfig,
  target: Required<OcxComboTarget>,
): void;

export function clearComboSelectionState(comboId?: string): void;
export function tryPickComboModel(config: OcxConfig, modelId: string): ComboPick | null;
```

`pickComboTarget` composes three eligibility gates: provider still exists/enabled,
target key is not excluded, and the optional 030 callback returns true. For RR it first
reuses `state.activeKey` if eligible; otherwise it clears the active sticky fields and
runs SWRR. For failover it scans config order and never mutates RR state.

`noteComboSuccess` increments only when the successful target equals `activeKey`; it
clears `activeKey` when `successes >= stickyLimit` but preserves `currentWeights`.
There is deliberately no production caller in 020; repeated `routeModel` calls stay
pinned and the unit sequence helpers call it explicitly. 030 adds the production
success call plus `noteComboFailure`, cooldowns, and attempt advancement without
changing SWRR.

`tryPickComboModel` returns null for non-combo IDs, throws `UnknownComboError` for an
unknown combo, and throws `NoAvailableComboTargetsError` when all targets are stale,
disabled, excluded, or later cooled. `NoAvailableComboTargetsError` exposes the stable
code `combo_unavailable`. Add/export both error classes so route and request tests assert
the fail-closed reason instead of generic text. `pickComboTarget` and
`tryPickComboModel` must obtain definitions through the own-property-safe `getCombo`;
they must never select through `config.combos?.[id]`. Thus inherited names such as
`constructor` and `toString` are unknown combos, not definitions.

### 4.4 `src/combos/index.ts` — NEW — stable public barrel

Export only the types/constants/functions required by router, config, management API,
tests, and future slices:

```ts
export {
  COMBO_DEFAULT_EFFORT,
  COMBO_NAMESPACE,
  comboConfigError,
  comboConfigIssues,
  comboDefaultEffort,
  comboModelId,
  getCombo,
  isValidComboId,
  listComboIds,
  normalizeComboConfig,
  parseComboModelId,
  targetKey,
} from "./types";
export {
  clearComboSelectionState,
  NoAvailableComboTargetsError,
  noteComboSuccess,
  pickComboTarget,
  tryPickComboModel,
  UnknownComboError,
  type ComboPick,
} from "./resolve";
```

Do not create `src/combos/effort.ts` in 020: after review, its only safe 020 behavior is
the pure `comboDefaultEffort` getter already owned by `types.ts`.

### 4.5 `src/config.ts` — MODIFY — shared validation with persisted disabled-member support

Add an import from the cycle-free combo owner:

```ts
import { comboConfigIssues } from "./combos/types";
```

Before the current `superRefine` ends at `src/config.ts:443`, add:

```ts
  const combos = (config as { combos?: unknown }).combos;
  if (combos !== undefined) {
    if (!combos || typeof combos !== "object" || Array.isArray(combos)) {
      ctx.addIssue({ code: "custom", path: ["combos"], message: "combos must be an object" });
    } else {
      for (const [id, raw] of Object.entries(combos as Record<string, unknown>)) {
        for (const issue of comboConfigIssues(id, raw, config.providers)) {
          ctx.addIssue({
            code: "custom",
            path: ["combos", id, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  }
```

Preserve all current provider validation at `src/config.ts:367-435` and the
`defaultProvider` own-property check at `:436-442`. The default validator mode shown
above intentionally accepts disabled members, including an all-disabled combo saved by
successive provider PATCH calls. The API calls the same `comboConfigIssues` with its
mutation option; there is no second handwritten combo schema in this file.

Because `comboConfigIssues` is invoked only for actual persisted combo entries or a
PUT-upsert candidate, a provider named `combo` with no configured combos remains valid
and current explicit provider routing is unchanged. The first persisted/candidate combo
activates the reserved-namespace rejection. The same shared validator rejects a combo ID
that is an own key of `config.providers`; inherited provider keys do not count.

### 4.6 `src/router.ts` + `src/server/responses.ts` — MODIFY — expand combo and expose typed unavailability

Add imports:

```ts
import { COMBO_NAMESPACE, tryPickComboModel, type ComboPick } from "./combos";
```

Extend, do not replace, current `RouteResult` (`src/router.ts:7-12`):

```ts
export interface RouteResult {
  providerName: string;
  provider: OcxProviderConfig;
  modelId: string;
  codexAccountMode?: CodexAccountMode;
  combo?: ComboPick;
}
```

Insert at the start of `routeModel` before current explicit namespace routing:

```ts
  const preservePhysicalComboProvider =
    hasOwnProvider(config.providers, COMBO_NAMESPACE)
    && Object.keys(config.combos ?? {}).length === 0;
  if (!preservePhysicalComboProvider) {
    const combo = tryPickComboModel(config, modelId);
    if (combo) {
      const concrete = `${combo.target.provider}/${combo.target.model}`;
      const routed = routeModel(config, concrete);
      return { ...routed, combo };
    }
  }
```

This is the only precedence exception: with an own physical provider named `combo` and
zero configured combos, fall through to the unchanged explicit-provider router below.
Once any combo exists, config validation forbids that physical provider and virtual
combo lookup has precedence as defense in depth if invalid config is injected directly.

Leave current `routeResult()`, canonical OpenAI routing, legacy provider rejection,
disabled checks, pattern routing, configured-model routing, and default fallback
byte-for-byte. Runtime stale-member filtering in `pickComboTarget` is what prevents a
missing combo target from ever reaching the dangerous `router.ts:242-245` default path.

Add this direct wire-envelope helper above `handleResponses` in 020:

```ts
function comboUnavailableResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "server_error", code: "combo_unavailable" },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}
```

At the existing `handleResponses` route-error boundary, map
`NoAvailableComboTargetsError` through `comboUnavailableResponse(error.message)` before
the generic `invalid_request_error` mapping. Do not use `formatErrorResponse` here:
the current implementation at `src/bridge.ts:917` delegates to `classifyError`,
whose status-503 precedence rewrites the wire code to `server_is_overloaded` (confirmed
by the pre-build probe). This helper is classification-only—not response
execution—and makes the all-disabled path observable as status 503 with
`error.type === "server_error"` and `error.code === "combo_unavailable"`. 030 reuses this
020-owned helper when its outer failover loop receives no initial eligible pick; it does
not redefine or replace it.

### 4.7 `src/server/management-api.ts` — MODIFY — combo GET/PUT-upsert/DELETE and deletion dependency guard

#### A. Guard provider deletion

Before (`src/server/management-api.ts:643-648`):

```ts
  if (url.pathname === "/api/providers" && req.method === "DELETE") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (name === config.defaultProvider) return jsonResponse({ error: "cannot delete the default provider; set another default first" }, 400);
    const { saveConfig: save } = await import("../config");
    delete config.providers[name];
```

After the default-provider guard and before `saveConfig` import:

```ts
    const dependentCombos = Object.entries(config.combos ?? {})
      .filter(([, combo]) => combo.targets.some(target => target.provider === name))
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    if (dependentCombos.length > 0) {
      return jsonResponse({
        error: `cannot delete provider "${name}" while combos depend on it`,
        combos: dependentCombos,
      }, 409);
    }
```

The response must occur before any mutation, cache clear, catalog refresh, or save.

#### B. Add combo GET/PUT-upsert/DELETE before `/api/stop`

Reconstruct GET, PUT-upsert, and DELETE routes with these corrections. Combo POST and
PATCH routes are intentionally absent; PUT is the sole whole-value create/update verb,
matching persisted-config replacement semantics.

```ts
  if (url.pathname === "/api/combos" && req.method === "GET") {
    const { comboModelId, getCombo, listComboIds } = await import("../combos");
    return jsonResponse({ combos: listComboIds(config).map(id => ({
      id,
      model: comboModelId(id),
      ...getCombo(config, id)!,
    })) });
  }

  if (url.pathname === "/api/combos" && req.method === "PUT") {
    let rawBody: unknown;
    try { rawBody = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(rawBody)) {
      return jsonResponse({ error: "request body must be an object" }, 400);
    }
    const body = rawBody;
    if (typeof body.id !== "string" || !body.id.trim()) {
      return jsonResponse({ error: "id is required and must be a string" }, 400);
    }
    const id = body.id.trim();
    const { comboConfigError, normalizeComboConfig, comboModelId, clearComboSelectionState } = await import("../combos");
    const error = comboConfigError(id, body.combo, config.providers, {
      requireEnabledTarget: true,
    });
    if (error) return jsonResponse({ error }, 400);
    const normalized = normalizeComboConfig(body.combo as import("../types").OcxComboConfig);
    config.combos = { ...(config.combos ?? {}), [id]: normalized };
    saveConfig(config);
    clearComboSelectionState(id);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true, id, model: comboModelId(id), combo: normalized });
  }

  if (url.pathname === "/api/combos" && req.method === "DELETE") {
    const id = url.searchParams.get("id")?.trim();
    if (!id) return jsonResponse({ error: "id query param is required" }, 400);
    if (!Object.prototype.hasOwnProperty.call(config.combos ?? {}, id)) {
      return jsonResponse({ error: "unknown combo" }, 404);
    }
    const { clearComboSelectionState } = await import("../combos");
    delete config.combos![id];
    if (Object.keys(config.combos!).length === 0) delete config.combos;
    saveConfig(config);
    clearComboSelectionState(id);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true, id });
  }
```

The `typeof body.id` check closes Sol P3; optional chaining on unknown is forbidden.
Parse JSON as `unknown` and reuse the existing local `isPlainRecord` helper before any
property read. JSON `null`, arrays, strings, numbers, and booleans all return 400 without
throwing or mutating config.
Use own-property lookup for DELETE so inherited names cannot be deleted accidentally.
030 extends PUT/DELETE state reset to cooldowns.

### 4.8 `tests/combos.test.ts` — NEW — exact domain sequences, no probabilistic assertions

Reconstruct useful PR parsing/failover fixtures, delete the `Math.random()`-dependent
test, and add exact assertions:

```ts
test("equal-weight RR rotates exactly", () => {
  const config = rrConfig({ stickyLimit: 1, weights: [1, 1, 1] });
  expect(successfulPicks(config, 6)).toEqual(["a/m1", "b/m2", "c/m3", "a/m1", "b/m2", "c/m3"]);
});

test("smooth weights and sticky successes have a deterministic sequence", () => {
  const config = rrConfig({ stickyLimit: 2, weights: [2, 1] });
  expect(successfulPicks(config, 12)).toEqual([
    "a/m1", "a/m1", "b/m2", "b/m2", "a/m1", "a/m1",
    "a/m1", "a/m1", "b/m2", "b/m2", "a/m1", "a/m1",
  ]);
});

test("disabled members are skipped through the supported runtime path", () => {
  const config = baseConfig();
  config.providers.a!.disabled = true; // API activation is covered in combo-management-api.test.ts
  expect(pickComboTarget(config, "free")?.target.provider).toBe("b");
  config.providers.b!.disabled = true;
  expect(() => tryPickComboModel(config, "combo/free")).toThrow(NoAvailableComboTargetsError);
  expect(() => routeModel(config, "combo/free")).toThrow(NoAvailableComboTargetsError);
});

test("missing members fail closed after unsupported in-memory corruption", () => {
  const config = baseConfig();
  delete config.providers.a; // defense in depth only; DELETE API and config validation forbid this state
  expect(pickComboTarget(config, "free")?.target.provider).toBe("b");
});
```

Also cover: parser namespace/empty suffix and no-trim suffix behavior; unknown combo;
reserved inherited IDs (`combo/constructor` and `combo/toString`) throwing
`UnknownComboError`, with `getCombo` returning undefined and `comboDefaultEffort`
returning null for both inherited names (use a config containing at least one real combo
so virtual lookup is active); ordered failover first pick; exclude set; state reset;
repeated picks without a success notification remain pinned at the 020 tip;
sticky failures not counted (using the 030 helper only after 030 lands);
every validation matrix row; normalization after valid input; and `comboDefaultEffort`
default/custom/defensive-null behavior.

### 4.9 `tests/config.test.ts` — MODIFY — shared-rule parity and persisted policy split

Add a table that writes invalid config JSON and asserts `readConfigDiagnostics()` uses
`source: "fallback"` with the same message returned by `comboConfigError` for:

- malformed combo map;
- invalid strategy/sticky/default effort;
- empty targets;
- unknown provider;
- blank model;
- fractional/out-of-range weight;
- duplicate normalized target;
- provider `combo` plus a configured combo, with the reserved-namespace collision text;
- combo ID equal to an existing provider name, with both sides named in the error.

Add valid config-load assertions proving normalized values survive without mutation and
that one-disabled and all-disabled persisted combos both return `source:"file"` with no
diagnostic or fallback after reload. The test must compare API/domain and config messages
for policy-independent invalid rows, not merely assert both are non-null. The
all-disabled mutation-only error is asserted through `comboConfigError(...,
{requireEnabledTarget:true})` and the PUT API, not through persisted-config diagnostics.

### 4.10 `tests/combo-management-api.test.ts` — NEW — GET/PUT-upsert/DELETE and provider-deletion guard

Call `handleManagementAPI` directly with an isolated `OPENCODEX_HOME`. Cover GET sorted
output; PUT create/update and normalized defaults; POST/PATCH are not accepted as combo
create/update operations and leave config/disk unchanged; PUT null/array/string/number/
boolean root bodies return 400 before property access; PUT object/array/number `id` values
return 400 without throwing; invalid combo does not mutate/save; DELETE unknown; DELETE
success clears final map; provider deletion returns 409 with sorted combo IDs and leaves
provider/config file unchanged; provider deletion succeeds after dependency removal.
PUT with one disabled and one enabled configured member succeeds; PUT with only disabled
configured members returns 400 and leaves disk bytes unchanged. For reachable runtime
eligibility, PUT a combo using enabled providers A/B, PATCH A with `{"disabled":true}`,
send a combo request, and assert the observed physical route/provider is B. Then PATCH B
disabled (with a separate enabled default provider C), reload the saved config to prove
the combo survives as `source:"file"`, send the same combo request, and assert HTTP 503
with `error.code === "combo_unavailable"` and `error.type === "server_error"`, no upstream
hit, and no fallback hit on C. Do not delete provider-map entries directly in this
activation test.

### 4.11 `tests/router.test.ts` — MODIFY — preserve current routing while adding combo cases

Add cases for concrete combo expansion, combo metadata, unknown combo, disabled-member
skip, all-disabled failure, and repeated 020-tip routing staying pinned without a
success notification. Add the backward-compatibility regression that a physical
provider literally named `combo`, with no configured combos, still routes
`combo/model` through that provider exactly as before. A direct missing-member mutation
is a separately labelled defense-in-depth case, not activation proof. Keep all existing canonical OpenAI and
legacy provider tests unchanged to prove the PR hunk did not regress current routing.

## 5. Conditional-path activation matrix

Every new conditional must have a trigger and an observable assertion:

| Conditional path | Test activation | Observable proof |
|---|---|---|
| non-combo ID | `parseComboModelId("a/m")` | returns null; normal router case unchanged |
| empty/unknown combo | `combo/`, `combo/missing` | null parser / typed unknown error |
| inherited-name combo lookup | `combo/constructor`, `combo/toString` | `UnknownComboError`; no inherited definition selected |
| physical `combo` provider, no combos | route `combo/model` | current physical-provider route preserved |
| physical `combo` provider plus combo config/PUT | load or PUT first combo | validation 400/fallback with named reserved-namespace collision |
| combo ID/provider-name collision | PUT/load combo `a` while provider `a` exists | validation 400/fallback naming `a` collision |
| valid custom/default effort | omitted vs `high` | normalized `medium` vs `high`; no mutation |
| malformed persisted field | write each policy-independent invalid table row | diagnostics fallback and exact API message parity |
| valid persisted disabled combo | PATCH one/all members disabled, reload | source `file`, combo retained, no diagnostics error |
| failover selection | strategy omitted | first eligible config-order target |
| RR equal weights | six success notes | exact A,B,C sequence |
| RR unequal weights | weights 2:1 | exact A,B,A selection-batch sequence |
| sticky hold | `stickyLimit:2` | each batch target appears twice |
| 020 production activation boundary | route the same RR combo twice without response notification | same first target; static until 030 |
| failure/no success note | pick twice without note | same active sticky target |
| exclude gate | exclude selected key | next eligible target |
| partially disabled target (reachable) | PUT A/B combo, PATCH A disabled, send request | B is the only physical upstream hit |
| all-disabled target (reachable) | PATCH B disabled, reload, send request | config remains file-backed; 503 with code `combo_unavailable`, type `server_error`; no default/upstream hit |
| all-disabled PUT-upsert | submit only disabled configured members | 400, disk bytes unchanged |
| missing target (defense in depth) | mutate provider map directly in unit test | skip missing target; explicitly not activation proof |
| state reset | pick+success, clear, pick | sequence restarts at A |
| API malformed JSON | broken body | 400, no config mutation |
| API non-record root | `null`, array, string, number, boolean | 400 before property access; no config mutation |
| API non-string ID (P3) | object/array/number | 400, no thrown TypeError |
| unsupported combo verbs | POST/PATCH `/api/combos` | no create/update; config and disk unchanged |
| API invalid combo | unknown provider/duplicate | 400 and disk bytes unchanged |
| provider delete dependency | A used by two combos | 409 + sorted IDs + provider remains |
| provider delete after cleanup | delete/update combos first | 200 + provider absent |
| combo delete last entry | one combo | `config.combos` removed, state reset |
| default-provider fallback hazard | all combo members disabled, default C | 503 `combo_unavailable`; no route/upstream hit on C |

## 6. Commit plan and attribution

Estimated commit count: **4**. This section is the source of truth for the 020 commit
boundary; any three-commit summary elsewhere is stale and must not drive execution.

1. `feat(combos): reconstruct virtual model namespace primitives`
   - Author `Wibias <37517432+Wibias@users.noreply.github.com>`; maintainer committer.
   - Files: source-faithful combo target/strategy/config shapes, namespace constants,
     model-id parse/format helpers—including the contributor source's suffix `.trim()`—
     and direct helper tests only.
   - Excludes narrowed `defaultEffort` types, strict normalization/validation, SWRR,
     the final wire-ID no-trim change, router/API redesign, deletion prevention, and all
     Sol/audit repairs.
2. `feat(combos): land validated CRUD and routing on current dev`
   - Author: maintainer; `Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`.
   - Files: narrowed types, wire-model-ID suffix no-trim behavior, shared strict
     validation/normalization, namespace-collision and own-property hardening, router
     expansion, direct `combo_unavailable` envelope, GET/PUT-upsert/DELETE API contract,
     provider deletion guard, and root-body/P3 hardening.
   - Body names Sol P1/P2/P3 findings and reviewed head `a4abda10`.
3. `fix(combos): make selection deterministic and runtime eligibility fail closed`
   - Author: maintainer; `Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`.
   - Files: SWRR selector/state redesign and exact sequence/eligibility tests.
4. `test(combos): lock config API routing and 020 activation boundaries`
   - Author: maintainer; `Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`.
   - Files: management/config/router integration matrices, collision/backward-compat/
     reserved-key/body-root/verb regressions, supported provider-PATCH activation,
     reload plus exact request-level `combo_unavailable` envelope proof, pinned 020-tip
     proof, and labelled defense-in-depth corruption test only.

Each commit must pass its focused tests; the slice tip must pass every gate below.
All 020 range checks use `HEAD~4..HEAD`; that full four-commit range is required for a
valid 020 proof.

## 7. Verification gates

Focused:

```bash
bun test --isolate \
  tests/combos.test.ts \
  tests/combo-management-api.test.ts \
  tests/config.test.ts \
  tests/router.test.ts
bun run typecheck
```

Full 020 tip:

```bash
bun test --isolate ./tests/
bun run privacy:scan
git diff --check
```

Static exactness checks:

```bash
rg -n "Math\.random|defaultReasoningLevel|applyComboDefaultEffort" src/combos src/config.ts src/router.ts src/server/management-api.ts
rg -n "comboConfigIssues|combo_unavailable" \
  src/combos/types.ts src/config.ts src/server/management-api.ts src/server/responses.ts
test "$(git rev-list --count HEAD~4..HEAD)" -eq 4
git diff --name-only HEAD~4..HEAD
```

Expected first command has no matches. The second shows one validation definition, its
config/API consumers, and the direct response mapping. The count locks the four-commit
SSOT boundary; the changed-file list is limited to the files declared in §4.

## 8. Rollback

Revert commits in reverse order. The source is additive except for narrow router/config/
management hooks, so rollback removes `src/combos/`, combo types, schema block, routes,
and tests without a config migration. If users created `combos` during a local smoke,
remove that key from the test config before checking out a pre-020 binary; older config
loading is passthrough but the feature is inert. Do not delete providers or rewrite the
immutable source branch as rollback.

## 9. Findings closure

| Finding | Closure in 020 | Proof |
|---|---|---|
| P1 sticky RR is weighted-random; success rotation ignores stickyLimit; tautological test | SWRR state, successful-batch sticky counter, exact deterministic sequences | `tests/combos.test.ts` exact A/B/C and 2:1+sticky arrays; no `Math.random` |
| P1 deleted members fall through to default provider | prevent orphaning through config/PUT/DELETE; persisted PATCH-disabled members remain valid and runtime selection skips/fails closed with `combo_unavailable`; missing-map handling remains defense in depth | management API PUT→PATCH→reload→request activation, no-default-hit assertion, separately labelled corruption unit |
| P2 persisted/API validation policy | one `comboConfigIssues` owner with explicit mutation-only enabled-count gate | parity table for shared invalid rows; persisted all-disabled file-load proof; PUT all-disabled rejection |
| P3 `body.id?.trim()` on unknown | `typeof body.id === "string"` before trim | object/array/number API tests return 400 |
| post-review `6824e7bc` defaultEffort | narrow type, parity validation, normalized getter; application/catalog deliberately assigned to 030/040 | domain/config tests and slice-boundary checks |
| 503 classification rewrites `combo_unavailable` | 020-owned direct JSON envelope bypasses `formatErrorResponse`/`classifyError` | E2E asserts status 503, type `server_error`, code `combo_unavailable` |
| physical/virtual namespace ambiguity | reserve `combo/` when combos exist; reject combo-ID/provider-name collisions; preserve lone physical `combo` provider | config/API collision tests plus router backward-compat regression |
| inherited combo-map properties | own-property gates in `getCombo`, `comboDefaultEffort`, and selection | `combo/constructor` and `combo/toString` throw `UnknownComboError` |
| PUT root body assumed object | parse as `unknown`, then gate with existing `isPlainRecord` | null/array/scalar roots return 400 without mutation |
| combo API verb ambiguity | GET/PUT-upsert/DELETE only; no POST/PATCH create/update | unsupported-verb tests leave config/disk unchanged |
| source/parser attribution drift | source trim in Wibias commit; no-trim behavior in maintainer commit with co-author trailer | four-commit log/range audit over `HEAD~4..HEAD` |

## 10. 020 done gate

020 is complete only when the pure exact selection sequences pass repeatedly, a separate
020-tip test proves production RR stays pinned until 030, policy-independent invalid
shapes have config/PUT message parity, namespace collisions fail validation while a lone
physical `combo` provider still routes, inherited combo names fail as unknown, persisted
all-disabled state survives reload while PUT all-disabled is rejected, null/array/scalar
PUT roots fail before property access, POST/PATCH cannot mutate combos, provider deletion
cannot orphan a combo, the supported PATCH-disable path reaches the runtime eligibility
guard, all-disabled requests emit the exact 503 `server_error`/`combo_unavailable`
envelope and never reach `defaultProvider`, current router tests remain green, the four
commit range is `HEAD~4..HEAD`, full tests/typecheck/privacy pass, and no 030/040 behavior
has leaked into this slice.

## Audit fold-back 2026-07-18

- Blocker 1: chose the truthful static-selection option for the independently green
  020 tip; added an activation boundary and pinned-production test, with success-driven
  RR activation assigned to 030.
- Blocker 2: narrowed closure to orphan prevention plus reachable PATCH-disabled runtime
  handling; direct missing-member mutation is labelled defense in depth only.
- Blocker 3: retained the cooldown-reset handoff and now points to 030's concrete
  management-API MODIFY/API activation coverage.
- Blocker 6: replaced the `comboConfigIssues` comment body with complete current-dev code.
- Blocker 7: split the Wibias-authored commit down to source-faithful primitives; every
  narrowed type, strict normalization, SWRR, and hardening change is maintainer-authored
  with the Wibias co-author trailer.
- Rebuttal: none; the audit blockers were accepted as stated.

### Round 2

- R1 (HIGH): made disabled membership coherent across persistence, management mutation,
  restart, and selection. Persisted config now permits disabled members; PUT-upsert
  rejects only the zero-enabled case; provider DELETE remains 409-guarded; activation
  now proves PATCH-one skips to B and PATCH-all survives reload then fails closed as
  `combo_unavailable` without touching the default provider.

## Pre-build fold-back round 3 (2026-07-18)

- Blocker 1 (HIGH), `combo_unavailable` envelope: moved the direct
  `comboUnavailableResponse()` definition into §4.6/020, bypassing the 503 rewrite in
  `formatErrorResponse`/`classifyError`; §4.10 now asserts code `combo_unavailable` and
  type `server_error`, and 030 is explicitly a consumer of the 020-owned helper.
- Blocker 2 (HIGH), namespace collision: §3.1, §4.2, §4.5, §4.9, §4.11, and §5 now
  reserve `combo/` only when combos exist, reject physical-provider/virtual-ID
  collisions with named errors, and preserve routing for a lone physical provider named
  `combo` as the backward-compatible no-combos case.
- Blocker 3 (MEDIUM), own-property safety: §4.2/§4.3 use explicit own-property gates for
  `getCombo`, `comboDefaultEffort`, and unknown-combo selection; §4.8/§5 add
  `combo/constructor` and `combo/toString` regressions expecting `UnknownComboError`.
- Blocker 4 (MEDIUM), PUT root-body validation: §4.7 parses JSON as `unknown`, reuses
  `isPlainRecord` before property access, and §4.10/§5 cover null, array, and scalar 400s.
- Blocker 5 (MEDIUM), API verb contract: §3.1/§4.7 lock whole-value PUT-upsert as the sole
  create/update operation alongside GET/DELETE; POST/PATCH are intentionally absent and
  tests prove they do not mutate config or disk.
- Blocker 6 (MEDIUM), commit plan: §6 remains the four-commit SSOT and all range proof is
  `HEAD~4..HEAD`; contributor-source suffix trimming stays in commit 1, while final
  no-trim wire behavior moves to maintainer-authored commit 2 with the exact Wibias
  co-author trailer.
