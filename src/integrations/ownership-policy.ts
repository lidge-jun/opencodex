/**
 * Client-scoped exceptions to strict managed-fragment ownership.
 *
 * Most clients must preserve every byte represented by their managed
 * contribution. A client that persists runtime-derived fields back into an
 * OpenCodex-owned fragment needs a narrower contract: name the exact paths it
 * may rewrite, then fingerprint everything else. Keeping that policy here
 * prevents a client quirk from weakening the shared classifier.
 */
import {
  OPENCODE_PROVIDER_ID,
  type ManagedContribution,
  type ManagedFragment,
} from "../clients/config-export";
import { canonicalContribution, fingerprint } from "./ownership";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

/** Delete one nested object member and prune only the empty ancestors created by that deletion. */
function deletePath(root: unknown, path: readonly string[]): void {
  if (!isObject(root) || path.length === 0) return;
  const parents: Array<{ parent: JsonObject; key: string }> = [];
  let cursor: JsonObject = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;
    const next = cursor[key];
    if (!isObject(next)) return;
    parents.push({ parent: cursor, key });
    cursor = next;
  }
  delete cursor[path[path.length - 1]!];
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    if (Object.keys(cursor).length > 0) break;
    const { parent, key } = parents[index]!;
    delete parent[key];
    cursor = parent;
  }
}

function cloneFragment(fragment: ManagedFragment): ManagedFragment {
  return {
    path: [...fragment.path],
    value: structuredClone(fragment.value),
  };
}

/**
 * Paths a client is documented to derive after OpenCodex writes its block.
 *
 * ZCode 3.8.1 persists reasoning and output defaults for every generated
 * model. It may also fill a context default when OpenCodex intentionally
 * omitted one; an authoritative context emitted by OpenCodex remains
 * protected and is never listed here.
 */
export function refreshablePathsOf(
  contribution: ManagedContribution,
): readonly (readonly string[])[] {
  if (contribution.clientId !== "zcode") return [];
  const fragment = contribution.fragments.find(candidate => (
    candidate.path.length === 2
    && candidate.path[0] === "provider"
    && candidate.path[1] === OPENCODE_PROVIDER_ID
  ));
  if (!fragment || !isObject(fragment.value) || !isObject(fragment.value.models)) return [];

  const paths: string[][] = [];
  for (const modelId of Object.keys(fragment.value.models).sort()) {
    const entry = fragment.value.models[modelId];
    if (!isObject(entry)) continue;
    const base = [...fragment.path, "models", modelId];
    paths.push([...base, "reasoning"]);
    paths.push([...base, "limit", "output"]);
    const limit = entry.limit;
    if (!isObject(limit) || typeof limit.context !== "number") {
      paths.push([...base, "limit", "context"]);
    }
  }
  return paths;
}

export function validRefreshablePaths(
  contribution: ManagedContribution,
  value: unknown,
): value is readonly (readonly string[])[] {
  if (contribution.clientId !== "zcode" || !Array.isArray(value) || value.length === 0) {
    return false;
  }
  const fragment = contribution.fragments.find(candidate => (
    candidate.path.length === 2
    && candidate.path[0] === "provider"
    && candidate.path[1] === OPENCODE_PROVIDER_ID
  ));
  if (!fragment || !isObject(fragment.value) || !isObject(fragment.value.models)) return false;

  const modelIds = new Set(Object.keys(fragment.value.models));
  const seen = new Set<string>();
  return value.every(path => {
    if (!Array.isArray(path) || !path.every(part => typeof part === "string")) return false;
    const modelId = path[3];
    const isReasoning = path.length === 5 && path[4] === "reasoning";
    const isLimitDefault = path.length === 6
      && path[4] === "limit"
      && (path[5] === "output" || path[5] === "context");
    const key = path.join("\u0000");
    if (
      path[0] !== "provider"
      || path[1] !== OPENCODE_PROVIDER_ID
      || path[2] !== "models"
      || typeof modelId !== "string"
      || !modelIds.has(modelId)
      || (!isReasoning && !isLimitDefault)
      || seen.has(key)
    ) return false;
    seen.add(key);
    return true;
  });
}

/** Fingerprint a contribution after removing only its explicitly refreshable paths. */
export function protectedContributionFingerprint(
  contribution: ManagedContribution,
  refreshablePaths: readonly (readonly string[])[],
): string {
  const fragments = contribution.fragments.map(cloneFragment);
  for (const refreshablePath of refreshablePaths) {
    for (const fragment of fragments) {
      if (!pathStartsWith(refreshablePath, fragment.path)) continue;
      deletePath(fragment.value, refreshablePath.slice(fragment.path.length));
      break;
    }
  }
  return fingerprint(canonicalContribution({ ...contribution, fragments }));
}
