/** Internal RequestInit metadata; never serialized into headers or upstream JSON. */
export const PROVIDER_HEADER_DEADLINE = Symbol("provider-header-deadline");
export type ProviderHeaderDeadline = { clientSignal: AbortSignal; pause(): void; resume(): void };

/** A local admission queue waits on client cancellation, outside the upstream header timer. */
export async function waitOutsideProviderHeaderDeadline<T>(
  init: RequestInit | undefined,
  wait: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = (init as (RequestInit & { [PROVIDER_HEADER_DEADLINE]?: ProviderHeaderDeadline }) | undefined)?.[PROVIDER_HEADER_DEADLINE];
  deadline?.pause();
  try { return await wait(deadline?.clientSignal ?? init?.signal ?? undefined); }
  finally { deadline?.resume(); }
}
