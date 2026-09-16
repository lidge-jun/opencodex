import { AUTH_ERROR_CODES, AUTH_HTTP_STATUS, TRANSIENT_HTTP_STATUS } from "./constants";

export function isTransientFailure(httpStatus: number | null, errorCode?: string | null): boolean {
  if (errorCode && AUTH_ERROR_CODES.has(errorCode)) return false;
  if (httpStatus == null) return true;
  if (AUTH_HTTP_STATUS.has(httpStatus)) return false;
  return TRANSIENT_HTTP_STATUS.has(httpStatus);
}

export function backoffMs(attempt: number, base = 1000, jitterRatio = 0.2): number {
  const capped = Math.min(5, Math.max(0, attempt));
  const raw = base * (2 ** capped);
  const jitter = 1 + (Math.random() * 2 - 1) * jitterRatio;
  return Math.round(raw * jitter);
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; classify?: (error: unknown) => { retry: boolean; httpStatus?: number | null; errorCode?: string | null } } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const classified = opts.classify?.(error);
      if (!classified) throw error;
      if (!classified.retry || !isTransientFailure(classified.httpStatus ?? null, classified.errorCode)) throw error;
      if (i === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, backoffMs(i)));
    }
  }
  throw last;
}

