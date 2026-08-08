import type { OcxConfig } from "../../types";
import { jsonResponse } from "../auth-cors";
import {
  DecompressedBodyTooLargeError,
  readBoundedJsonRequestBody,
} from "../request-decompress";

export const MANAGEMENT_JSON_BODY_MAX_BYTES = 4 * 1024 * 1024;

export function readManagementJsonBody<T = unknown>(req: Request): Promise<T> {
  return readBoundedJsonRequestBody(req, MANAGEMENT_JSON_BODY_MAX_BYTES) as Promise<T>;
}

export function readOptionalManagementJsonBody<T = unknown>(req: Request): Promise<T> {
  return readBoundedJsonRequestBody(req, MANAGEMENT_JSON_BODY_MAX_BYTES, undefined, {
    emptyBodyFallback: {},
  }) as Promise<T>;
}

export function managementBodyTooLargeResponse(
  error: unknown,
  req: Request,
  config: OcxConfig,
): Response | null {
  return error instanceof DecompressedBodyTooLargeError
    ? jsonResponse({ error: "request body too large" }, 413, req, config)
    : null;
}

export function rethrowManagementBodyTooLarge(error: unknown): void {
  if (error instanceof DecompressedBodyTooLargeError) throw error;
}

export async function readManagementJsonBodyOr<T>(req: Request, fallback: T): Promise<unknown | T> {
  try {
    return await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return fallback;
  }
}
