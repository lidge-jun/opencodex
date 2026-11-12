import { isPlainObject } from "../responses-snapshot-codec";

/** Parse the physical outbound request without accepting arrays or primitive JSON. */
export function parseOutboundRequestBody(bodyText: string): Record<string, unknown> | undefined {
  try {
    const body: unknown = JSON.parse(bodyText);
    return isPlainObject(body) ? body : undefined;
  } catch {
    return undefined;
  }
}
