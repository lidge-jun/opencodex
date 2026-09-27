/**
 * Responses codec entry points (PF-06).
 *
 * A named surface over the existing parser; no behavior of its own. `responsesToIr` is
 * `parseRequest` (`src/responses/parser.ts`), which turns a Responses body into the
 * adapter-neutral `OcxParsedRequest` every adapter builds from.
 */
import { parseRequest } from "../../responses/parser";
import type { OcxParsedRequest } from "../../types";
import { featuresFromResponsesBody } from "../features";

/** Parse a Responses body into the adapter-neutral request. */
export function responsesToIr(...args: Parameters<typeof parseRequest>): OcxParsedRequest {
  return parseRequest(...args);
}

export const responsesFeatures = featuresFromResponsesBody;
