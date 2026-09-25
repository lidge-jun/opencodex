export type AuthenticatedCatalogListener = (apiKeyId: string) => void;
export type OnAuthenticatedCatalog = (listener: AuthenticatedCatalogListener) => () => void;

export interface AdmissionWaitClock {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

export class AdmissionWaitError extends Error {
  readonly code = "admission_timeout";

  constructor(apiKeyId: string, timeoutMs: number) {
    super(`link key ${apiKeyId} was not admitted within ${timeoutMs}ms`);
    this.name = "AdmissionWaitError";
  }
}

const realClock: AdmissionWaitClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function awaitFirstAdmission(
  apiKeyId: string,
  timeoutMs: number,
  onAuthenticatedCatalog: OnAuthenticatedCatalog,
  clock?: AdmissionWaitClock,
): Promise<void>;
export function awaitFirstAdmission(
  onAuthenticatedCatalog: OnAuthenticatedCatalog,
  apiKeyId: string,
  timeoutMs: number,
  clock?: AdmissionWaitClock,
): Promise<void>;
export function awaitFirstAdmission(
  first: string | OnAuthenticatedCatalog,
  second: number | string,
  third: OnAuthenticatedCatalog | number,
  fourth?: AdmissionWaitClock,
): Promise<void> {
  const apiKeyId = typeof first === "string" ? first : second as string;
  const timeoutMs = typeof first === "string" ? second as number : third as number;
  const subscribe = typeof first === "string" ? third as OnAuthenticatedCatalog : first;
  const clock = fourth ?? realClock;
  if (!apiKeyId || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return Promise.reject(new Error("invalid admission wait arguments"));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: unknown;
    let unsubscribe: (() => void) | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    };
    try {
      timer = clock.setTimeout(() => finish(new AdmissionWaitError(apiKeyId, timeoutMs)), timeoutMs);
      unsubscribe = subscribe(observedKeyId => {
        if (observedKeyId === apiKeyId) finish();
      });
      if (settled) {
        unsubscribe();
        unsubscribe = undefined;
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
