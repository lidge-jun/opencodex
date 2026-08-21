/**
 * The one place that decides which models the management API offers as the
 * web-search sidecar, and which it refuses to persist (#2188).
 *
 * Two routes write `webSearchSidecar.model` — `PUT /api/sidecar-settings`
 * and the `webSearchSidecar` override in `PUT /api/claude-code`. They share
 * this module for the same reason the vision routes share
 * vision-sidecar-options.ts: a gate on one route and a stale copy on the
 * other is the same as no gate at all. `ocx config set` raw JSON writes
 * bypass management gates by design (operator escape hatch, same as vision).
 *
 * Unlike vision's provably-blind gate (reject only on positive proof), the
 * web-search gate is MEMBERSHIP: the executor set is closed and known, so an
 * id outside (candidates ∪ auth slots) can never run and is refused.
 */
import type { OcxConfig } from "../../types";
import { AUTH_SLOT_MODELS, resolveSidecarAuth } from "../../sidecar/auth";
import { pickerVisibleSidecarCandidates, type SidecarCandidate } from "../../sidecar/candidates";
import { WEB_SEARCH_BACKENDS, webSearchSidecarCandidates } from "../../web-search/backends";
import type { WebSearchBackendId } from "../../web-search/index";

// The full configured union. Rows only ever materialize for backends whose
// executor admits the candidate, so inert arms (gemini/exa without config)
// simply never produce rows.
export type WebSearchBackend = WebSearchBackendId;

export interface WebSearchCandidateRow extends SidecarCandidate {
  /** Executor backend that admitted this exact candidate row. */
  backend: WebSearchBackend;
}

export interface WebSearchModelOption {
  value: string;
  label: string;
  /** Exact runnable pair represented by this picker row. */
  backend: WebSearchBackend;
  model: string;
  /** True when the row is an auth-slot entitlement rather than a picker row. */
  authSlot?: boolean;
}

/** The candidate rows the web-search executors can actually run right now. */
export async function webSearchCandidateRows(config: OcxConfig): Promise<WebSearchCandidateRow[]> {
  const auth = resolveSidecarAuth(config);
  const all = await pickerVisibleSidecarCandidates(config, auth);
  return webSearchSidecarCandidates(config, auth, all).flatMap(candidate => {
   const descriptor = WEB_SEARCH_BACKENDS.find(entry =>
      entry.isActive(auth, config) && entry.eligibleModel(candidate, auth));
    return descriptor ? [{ ...candidate, backend: descriptor.backend }] : [];
  });
}

/**
 * The GUI/CLI option list. The persisted model is display-grandfathered so an
 * operator can SEE a now-illegal setting in the picker (parity with the vision
 * GET); new writes of such an id are still rejected by the gate below.
 */
export function webSearchModelOptionsFrom(
  config: Pick<OcxConfig, "webSearchSidecar">,
  candidates: readonly WebSearchCandidateRow[],
): WebSearchModelOption[] {
  const byValue = new Map<string, WebSearchModelOption>();
  for (const candidate of candidates) {
    if (byValue.has(candidate.id)) continue;
    byValue.set(candidate.id, {
      value: candidate.id,
      label: candidate.id,
      backend: candidate.backend,
      model: candidate.id,
      ...(candidate.authSlot ? { authSlot: true } : {}),
    });
  }
  const persisted = config.webSearchSidecar?.model;
  if (persisted && !byValue.has(persisted)) {
    byValue.set(persisted, {
      value: persisted,
      label: persisted,
      backend: config.webSearchSidecar?.backend ?? "openai",
      model: persisted,
    });
  }
  return [...byValue.values()].sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Membership gate: reject when the id is neither a runnable candidate nor an
 * auth-slot model. Auth slots pass even when the matching login is currently
 * absent — the slot is a legal setting whose executor simply is not live yet,
 * and refusing it would make settings order-dependent on login state.
 */
export function webSearchModelIsRejected(
  backend: WebSearchBackend,
  requested: string,
  candidates: readonly WebSearchCandidateRow[],
): boolean {
  if (requested === AUTH_SLOT_MODELS.codex) return backend !== "openai";
  if (requested === AUTH_SLOT_MODELS.anthropic) return backend !== "anthropic";
  return !candidates.some(candidate => candidate.backend === backend && candidate.id === requested);
}

/** Uniform 400 payload naming the filter, mirroring visionDescriberRejection's shape. */
export function webSearchModelRejection(
  field: string,
  backend: WebSearchBackend,
  requested: string,
  candidates: readonly WebSearchCandidateRow[],
): { error: string; allowedModels: string[] } {
  const allowed = new Set(candidates
    .filter(candidate => candidate.backend === backend)
    .map(candidate => candidate.id));
  // Preserve the response contract: allowedModels lists both always-configurable
  // auth-slot ids even though the pair gate below binds each to its own backend.
  allowed.add(AUTH_SLOT_MODELS.codex);
  allowed.add(AUTH_SLOT_MODELS.anthropic);
  return {
    error: `${field}: backend/model pair "${backend}/${requested}" is not a web-search sidecar candidate — ` +
      "the model must be picker-visible and runnable by that executor-backed backend (or its auth-slot model)",
    allowedModels: [...allowed].sort(),
  };
}
