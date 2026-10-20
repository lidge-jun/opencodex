import { registerProviderResponseProvenance } from "../providers/request-pacing";

/** Process-local outcome ownership; these markers never become upstream/client headers. */
const pausedResponses = new WeakMap<Response, true>();
const permanentResponses = new WeakMap<Response, true>();
registerProviderResponseProvenance(pausedResponses);
registerProviderResponseProvenance(permanentResponses);
export const wasAccountAutoPaused = (response: Response): boolean => pausedResponses.has(response);
export const wasPermanentAccountRefusal = (response: Response): boolean => permanentResponses.has(response);
export function markPermanentAccountRefusal(response: Response): void { permanentResponses.set(response, true); }
export function markAccountAutoPaused(response: Response): void { pausedResponses.set(response, true); }
export function inheritAccountAutoPauseResponse(source: Response, target: Response): Response {
  if (wasAccountAutoPaused(source)) markAccountAutoPaused(target);
  if (wasPermanentAccountRefusal(source)) markPermanentAccountRefusal(target);
  return target;
}
