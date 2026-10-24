import { registerProviderResponseProvenance } from "../providers/request-pacing";

const observers = new WeakMap<Response, (usage: unknown) => void>();
registerProviderResponseProvenance(observers);

export function attachCacheObservation(response: Response, observe: (usage: unknown) => void): void {
  observers.set(response, observe);
}

export function inheritCacheObservation(from: Response, to: Response): Response {
  const observer = observers.get(from);
  if (observer) observers.set(to, observer);
  return to;
}

export function observeAnthropicCacheUsage(response: Response, usage: unknown): void {
  try { observers.get(response)?.(usage); }
  catch { return; } // Optional observation failure must not fail the natural response.
}
