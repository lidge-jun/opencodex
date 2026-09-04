import {
  accountBoundNativeOpenAiSlugsBySelector,
  shouldIncludeAccountBoundNativeOpenAi,
  shouldIncludeNativeOpenAi,
  UPSTREAM_NATIVE_ENTRIES,
} from "../codex/catalog/metadata";
import { comboModelId, comboPublicModelId } from "../combos/types";
import { policyModelId, policyPublicModelId } from "../routing/profile";
import type { InboundWire } from "../providers/registry";
import { fastPolicyForModel } from "../providers/service-tier";
import type { OcxConfig } from "../types";
import {
  isKnownId,
  knownEffortRowIds,
  loadDetectedCursorEffortTable,
  parseEffortRowId,
  parseRequestEffortRowId,
  type EffortRowKnownIds,
  type ParsedEffortRowId,
} from "./effort-row";

/**
 * Synthetic Fast selectors: `<base-id>--fast` published on external model listings for
 * models whose resolved Fast policy is eligible, so a client that can only pick a model by
 * id reaches the priority service tier. The Codex app has a picker toggle for this; nothing
 * else did (devlog/_plan/260904_external_fast_wire).
 *
 * The marker is `--fast`, not `-fast`. Terminal `-fast` is a REAL id across this catalog —
 * grok-4-fast, glm-5.3-fast, gpt-5-fast, and every Cursor fast variant — so a single hyphen
 * cannot tell a product apart from a tier. `--` is the same terminal separator the effort-row
 * grammar relies on for the same reason.
 */
const FAST_ROW_SUFFIX = "--fast";

export interface ParsedFastRowId {
  baseId: string;
}

export interface ParsedSyntheticRow {
  fastRow: ParsedFastRowId | null;
  effortRow: ParsedEffortRowId | null;
}

export function fastRowId(baseId: string): string {
  return `${baseId}${FAST_ROW_SUFFIX}`;
}

/**
 * Whether a provider/model pair's resolved Fast policy may be published as a row.
 *
 * `eligible` alone. `unclassified` means capability is undefined, and `decideTier` makes
 * `fastMode` inert there, so publishing it would advertise a tier the runtime then refuses
 * to send.
 */
export function fastRowEligible(
  provider: Parameters<typeof fastPolicyForModel>[0],
  modelId: string,
  providerName?: string,
  inbound: InboundWire = "responses",
): boolean {
  return fastPolicyForModel(provider, modelId, providerName, inbound).eligibility === "eligible";
}

/**
 * Bases that may carry a fast row.
 *
 * Deliberately a SUPERSET of what the listings publish, and deliberately not
 * `knownEffortRowIds`. That set answers "which exact ids defeat the synthetic grammar"; it
 * does not answer "which bases are routable". Bare natives prove the gap: the `openai`
 * registry entry declares no `models` list and the default provider config declares none
 * either, because they route through a family-pattern rule instead. `gpt-5.6-sol` is
 * therefore absent from it, and requiring membership would publish `gpt-5.6-sol--fast` and
 * then refuse to parse it.
 *
 * Being too permissive costs nothing here: routing still rejects a base it cannot serve, and
 * the exact-id guard in `parseFastRowId` still protects real models. Being too strict breaks
 * the feature.
 *
 * Membership must not depend on the live-model cache. An earlier version seeded this set
 * from `knownEffortRowIds` alone, which reads `getStaleCached` (router.ts:125), so a
 * live-only model leaving the cache silently stopped its `--fast` selector from parsing.
 * The argument that its base row leaves the listing at the same time is true but
 * irrelevant: `/v1/models` is discovery, not a routing allowlist, and `routeModel` still
 * serves the bare base through the default provider (router.ts:791) and the qualified base
 * through its configured provider (router.ts:680). So the base kept working while only the
 * fast selector broke — the asymmetry this set exists to prevent.
 *
 * A pure Set cannot express this. Listings also publish LIVE-discovered and retained models
 * that appear in no config (`provider-fetch.ts` publishes `goModels` and `retainModels`), and
 * enumerating them means reading the very cache whose churn caused the original defect. So
 * this returns a PREDICATE: an id is a routable base when it is a known static/config id, or
 * when it is namespaced under an enabled configured provider. The second clause is
 * structural, so it holds for a live-discovered model without consulting the cache, and it
 * is exactly the shape `routeModel` uses to accept a qualified id (router.ts:680).
 *
 * A base is RECOGNIZED here and then judged by routing, which is the component that actually
 * knows whether it can serve it.
 */
export function fastRowBases(config: OcxConfig): (id: string) => boolean {
  const bases = new Set<string>();
  // Configured providers: any model the router would accept for this provider, plus the
  // namespaced and alias-namespaced spellings a listing can publish. Deliberately NOT
  // knownEffortRowIds, whose live-cache half makes membership time-dependent.
  for (const [providerName, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.disabled === true) continue;
    const namespaces = [providerName, providerConfig.alias].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const declared = [
      ...(providerConfig.models ?? []),
      ...(providerConfig.defaultModel ? [providerConfig.defaultModel] : []),
      ...Object.values(providerConfig.modelAliases ?? {}),
      ...(config.customModels ?? [])
        .filter(model => model.provider === providerName && model.modelId)
        .map(model => model.modelId),
    ];
    for (const id of declared) {
      bases.add(id);
      for (const namespace of namespaces) bases.add(`${namespace}/${id}`);
    }
  }
  // The STATIC upstream table, not `visibleNativeSlugs()`: that one filters by
  // disabled/shadowed state and reaches the catalog cache on disk, so it would both read a
  // file per parsed selector and SHRINK as runtime state changes. A base disappearing
  // mid-session would strand a client still holding the id it was published.
  if (shouldIncludeNativeOpenAi(config)) {
    for (const slug of UPSTREAM_NATIVE_ENTRIES.keys()) bases.add(slug);
  }
  if (shouldIncludeAccountBoundNativeOpenAi(config)) {
    // An EMPTY observed-entry list on purpose: the default argument reads the Codex models
    // cache and catalog from disk. The empty form still seeds every selector with the native
    // model set, and anything publishable is in UPSTREAM_NATIVE_ENTRIES anyway.
    for (const [selector, slugs] of accountBoundNativeOpenAiSlugsBySelector(config, [])) {
      for (const slug of slugs) bases.add(`${selector}/${slug}`);
    }
  }
  // Namespaces whose qualified ids route, whatever the cache currently holds.
  const namespaces = new Set<string>();
  // Virtual rows. A combo or routing profile is published under its canonical
  // `<namespace>/<id>` AND under an operator alias, which may be an arbitrary bare string
  // with no namespace to vouch for it, so the structural clause below cannot reach it. A
  // combo also cannot be covered by config.providers: declaring a provider named `combo`
  // is rejected outright (combos/types.ts:191).
  for (const [id, combo] of Object.entries(config.combos ?? {})) {
    bases.add(comboModelId(id));
    bases.add(comboPublicModelId(id, combo));
  }
  for (const [id, profile] of Object.entries(config.routingProfiles ?? {})) {
    bases.add(policyModelId(id));
    bases.add(policyPublicModelId(id, profile));
  }
  for (const [providerName, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.disabled === true) continue;
    namespaces.add(providerName.toLowerCase());
    if (typeof providerConfig.alias === "string" && providerConfig.alias.length > 0) {
      namespaces.add(providerConfig.alias.toLowerCase());
    }
  }
  return (id: string): boolean => {
    if (bases.has(id)) return true;
    const slash = id.indexOf("/");
    if (slash <= 0 || slash === id.length - 1) return false;
    // A live-discovered or retained model is published as `<provider>/<model>` and appears in
    // no config, so structural recognition is the only cache-free way to accept it.
    //
    // But NOT when the remainder itself ends in the marker. A real live model may legitimately
    // be named `foo--fast`; its exact id is protected by the known-id guard only while the
    // discovery cache still holds it, and after eviction that guard goes quiet while this
    // clause would still accept `provider/foo` structurally - silently routing a DIFFERENT
    // model than the client selected. Refusing the strip is the safe side: the caller then
    // sends the id verbatim and routing resolves the real model, or fails honestly.
    if (id.slice(slash + 1).endsWith(FAST_ROW_SUFFIX)) return false;
    return namespaces.has(id.slice(0, slash).toLowerCase());
  };
}

export function parseFastRowId(
  id: string,
  config: Pick<OcxConfig, "fastRows">,
  knownIds?: EffortRowKnownIds,
  routableBases?: EffortRowKnownIds,
): ParsedFastRowId | null {
  if (config.fastRows !== true) return null;
  if (!id.endsWith(FAST_ROW_SUFFIX)) return null;
  // An exact configured/public id always beats the synthetic grammar, the same precedence
  // effort rows use. An operator who really named a model `x--fast` keeps it.
  if (isKnownId(knownIds, id)) return null;
  const baseId = id.slice(0, -FAST_ROW_SUFFIX.length);
  if (baseId.length === 0) return null;
  return isKnownId(routableBases, baseId) ? { baseId } : null;
}

/**
 * True when an effort-row base still carries a fast marker, i.e. the selector nested the two
 * grammars. Composition is not supported, so such an id resolves to neither rather than
 * silently to whichever parser ran first.
 *
 * Known-id guarded, so a real model named `foo--fast` keeps its legitimate `foo--fast--high`
 * effort row.
 */
export function effortBaseCarriesFastMarker(
  baseId: string,
  knownIds: EffortRowKnownIds | undefined,
): boolean {
  return baseId.endsWith(FAST_ROW_SUFFIX) && !isKnownId(knownIds, baseId);
}

/**
 * Resolve one ingress selector against both synthetic grammars, returning at most one.
 * Callers pass the id the client sent and never a value another parser mutated.
 */
export function parseSyntheticRowId(
  id: string,
  config: OcxConfig,
  // Claude surfaces decode the alias before the marker is unambiguous, so they pass the
  // decoded form for Fast while effort parsing keeps seeing the id the client sent. A THUNK,
  // not a string: arguments are evaluated before the call, so an eager decode would run its
  // alias lookups even on the fastRows-off path this function exists to leave untouched.
  fastSelector?: () => string,
): ParsedSyntheticRow {
  // Fast off: delegate to the SAME function shipped today, so an install that never enables
  // this feature cannot observe any change, in behaviour or in cost.
  if (config.fastRows !== true) {
    return { fastRow: null, effortRow: parseRequestEffortRowId(id, config) };
  }
  const selector = fastSelector?.() ?? id;
  const wantsFast = selector.endsWith(FAST_ROW_SUFFIX);
  // Bail before building any inventory when neither grammar can match. A readable Claude
  // alias is `claude-ocx-<provider>--<model>`, so it ALWAYS contains `--`: testing only for
  // the separator would rebuild the whole model inventory on every Claude turn for a
  // selector that cannot be a fast row. With effort parsing off, the terminal suffix is the
  // only thing that can match.
  const wantsEffort = config.cursorEffortRows === true && id.lastIndexOf("--") > 0;
  if (!wantsFast && !wantsEffort) return { fastRow: null, effortRow: null };
  const knownIds = knownEffortRowIds(config);
  const fastRow = wantsFast
    ? parseFastRowId(selector, config, knownIds, fastRowBases(config))
    : null;
  if (fastRow) return { fastRow, effortRow: null };
  // Cursor install detection stays behind its own flag, exactly as parseRequestEffortRowId
  // gates it today.
  const effortRow = wantsEffort
    ? parseEffortRowId(id, config, { knownIds, table: loadDetectedCursorEffortTable() })
    : null;
  return effortRow && effortBaseCarriesFastMarker(effortRow.baseId, knownIds)
    ? { fastRow: null, effortRow: null }
    : { fastRow: null, effortRow };
}

/** Fast-only resolution for surfaces that never parsed an effort row. */
export function parseFastOnlyRowId(
  config: OcxConfig,
  selector: () => string,
): ParsedFastRowId | null {
  if (config.fastRows !== true) return null;
  return parseSyntheticRowId("", config, selector).fastRow;
}

/**
 * Add a fast sibling beside an eligible row. The base row is always kept: a fast row is an
 * addition, never a replacement. That is the deliberate difference from `fastMode`, which
 * replaces the listed Cursor id — replacement suits a global switch, but a per-request
 * selector has to leave the default reachable.
 */
export function expandFastRow<T extends { id: string }>(
  row: T,
  eligible: boolean,
  config: Pick<OcxConfig, "fastRows">,
  knownIds?: EffortRowKnownIds,
): T[] {
  if (config.fastRows !== true || !eligible) return [row];
  const id = fastRowId(row.id);
  return isKnownId(knownIds, id) ? [row] : [row, { ...row, id }];
}
