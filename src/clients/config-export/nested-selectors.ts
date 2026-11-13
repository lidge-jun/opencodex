import type { ExportModel } from "./contracts";
import { proveExportSelector, uniqueExportCandidates } from "./alias-selectors";
import { routedSlug } from "../../providers/slug-codec";
import type { OcxConfig } from "../../types";

/**
 * Raw nested selectors for Pi (#8172), proven by the serving proxy.
 *
 * A routed row whose upstream ID contains a slash is keyed by its encoded slug
 * (`openrouter/openrouter-free` for `openrouter/free`). That key routes only while the router's
 * inventory can decode it, so the raw `provider/upstream-id` spelling is offered when it is proven:
 * `config` is the admitted configuration of the process that builds the roster. Only Pi reads
 * these candidates, and every Pi document is built inside the serving proxy: `ocx export` reads
 * `/api/client-config`, and `ocx sync` refreshes Pi through `/api/client-integrations/pi/sync`,
 * so the CLI's saved configuration never proves a selector Pi writes. The raw selector reaches the same concrete provider, model and
 * account as the encoded key, and so does its Fast row, and no other row of the full roster claims
 * it. A cold inventory, a self-namespaced model that would win the raw spelling, a policy or combo
 * result, or a collision leaves the row without a candidate, and the encoded key stays.
 */
export function attachNestedSelectors(config: OcxConfig, input: readonly ExportModel[]): ExportModel[] {
  // A candidate is evidence for this configuration and inventory only; never carried across a reload.
  const models = input.map(({ nestedNamespaced: _priorCandidate, ...model }) => model);
  const candidates = models.map(model => {
    if (model.native || model.provider === "combo" || !model.provider || !model.id.includes("/")) return undefined;
    // Explicit aliases and other spellings are the operator's choice; only the encoded slug is replaced.
    if (model.namespaced !== routedSlug(model.provider, model.id)) return undefined;
    const candidate = `${model.provider}/${model.id}`;
    if (candidate === model.namespaced) return undefined;
    return proveExportSelector(config, model, candidate) ? candidate : undefined;
  });
  const unique = uniqueExportCandidates(models, candidates);
  return models.map((model, index) => {
    const candidate = unique[index];
    return candidate === undefined ? model : { ...model, nestedNamespaced: candidate };
  });
}

/** Pi's spelling: the proven raw selector where the serving proxy attached one, else the canonical key. */
export function selectNestedSelectors(models: readonly ExportModel[]): ExportModel[] {
  return models.map(({ nestedNamespaced, ...model }) => nestedNamespaced === undefined
    ? model : { ...model, namespaced: nestedNamespaced });
}
