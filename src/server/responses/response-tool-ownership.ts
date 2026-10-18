import type { ProviderExecutedCallType } from "../responses-undeclared-tool-guard";

// Route-authorized execution ownership follows only the response selected for delivery.
// It never becomes a wire header or mutable state shared by competing route attempts.
const providerCalls = new WeakMap<Response, ReadonlySet<ProviderExecutedCallType>>();

export function attachResponseToolOwnership(response: Response, types: ReadonlySet<ProviderExecutedCallType>): Response {
  if (types.size > 0) providerCalls.set(response, new Set(types));
  return response;
}

export function responseToolOwnership(response: Response): ReadonlySet<ProviderExecutedCallType> | undefined {
  return providerCalls.get(response);
}

/** Carry ownership only when rebuilding the same selected response body. */
export function carryResponseToolOwnership(source: Response, target: Response): Response {
  const types = providerCalls.get(source);
  if (types) providerCalls.set(target, types);
  return target;
}
