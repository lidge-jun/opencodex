import type { OcxProviderConfig, RequestPacingRule } from "../types";

interface Waiter {
  modelId?: string;
  providerIntervalMs: number;
  modelIntervalMs: number;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  abort?: () => void;
}

interface ProviderPacer {
  queue: Waiter[];
  providerNextStartAt: number;
  modelNextStartAt: Map<string, number>;
  timer?: ReturnType<typeof setTimeout>;
  active: boolean;
  lastStartedAt?: number;
  lastModelId?: string;
}

export interface ProviderRequestPacingStatus {
  provider: string;
  enabled: boolean;
  queued: number;
  nextSlotInMs: number;
  lastStartedAt?: number;
  lastModelId?: string;
}

const pacers = new Map<string, ProviderPacer>();

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function normalizedInterval(rule: RequestPacingRule | undefined): number {
  if (!rule) return 0;
  const rpmInterval = typeof rule.requestsPerMinute === "number" && rule.requestsPerMinute > 0
    ? 60_000 / rule.requestsPerMinute
    : 0;
  const fixedInterval = typeof rule.minIntervalMs === "number" && rule.minIntervalMs > 0
    ? rule.minIntervalMs
    : 0;
  return Math.max(rpmInterval, fixedInterval);
}

export function requestPacingIntervalMs(provider: OcxProviderConfig, modelId?: string): number {
  const policy = provider.requestPacing;
  if (!policy?.enabled) return 0;
  const override = modelId ? policy.models?.[modelId] : undefined;
  return Math.max(normalizedInterval(policy), normalizedInterval(override));
}

function requestPacingIntervals(provider: OcxProviderConfig, modelId?: string): {
  providerIntervalMs: number;
  modelIntervalMs: number;
} {
  const policy = provider.requestPacing;
  if (!policy?.enabled) return { providerIntervalMs: 0, modelIntervalMs: 0 };
  return {
    providerIntervalMs: normalizedInterval(policy),
    modelIntervalMs: modelId ? normalizedInterval(policy.models?.[modelId]) : 0,
  };
}

function runQueue(providerName: string, state: ProviderPacer): void {
  if (state.active) return;
  if (state.queue.length === 0) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    return;
  }
  if (state.timer) return;
  const now = Date.now();
  for (const [modelId, readyAt] of state.modelNextStartAt) {
    if (readyAt <= now) state.modelNextStartAt.delete(modelId);
  }
  const providerReadyAt = Math.max(now, state.providerNextStartAt);
  let waiterIndex = state.queue.findIndex(waiter => {
    const modelReadyAt = waiter.modelId ? (state.modelNextStartAt.get(waiter.modelId) ?? 0) : 0;
    return Math.max(providerReadyAt, modelReadyAt) <= now;
  });
  if (waiterIndex < 0) {
    let earliestAt = Number.POSITIVE_INFINITY;
    for (const waiter of state.queue) {
      const modelReadyAt = waiter.modelId ? (state.modelNextStartAt.get(waiter.modelId) ?? 0) : 0;
      earliestAt = Math.min(earliestAt, Math.max(providerReadyAt, modelReadyAt));
    }
    const delayMs = Math.max(0, earliestAt - now);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      runQueue(providerName, state);
    }, delayMs);
    return;
  }
  const waiter = state.queue[waiterIndex]!;
  const delayMs = Math.max(0, state.providerNextStartAt - now);
  if (delayMs > 0) {
    state.timer = setTimeout(() => {
      state.timer = undefined;
      runQueue(providerName, state);
    }, delayMs);
    return;
  }

  state.active = true;
  state.queue.splice(waiterIndex, 1);
  if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
  const startedAt = Date.now();
  state.lastStartedAt = startedAt;
  state.lastModelId = waiter.modelId;
  state.providerNextStartAt = startedAt + waiter.providerIntervalMs;
  if (waiter.modelId && waiter.modelIntervalMs > 0) {
    state.modelNextStartAt.set(waiter.modelId, startedAt + waiter.modelIntervalMs);
  }
  state.active = false;
  waiter.resolve();
  queueMicrotask(() => runQueue(providerName, state));
}

export async function waitForProviderRequestSlot(
  providerName: string,
  provider: OcxProviderConfig,
  modelId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const intervals = requestPacingIntervals(provider, modelId);
  if (Math.max(intervals.providerIntervalMs, intervals.modelIntervalMs) <= 0) return;
  if (signal?.aborted) throw abortReason(signal);

  const state = pacers.get(providerName) ?? {
    queue: [], providerNextStartAt: 0, modelNextStartAt: new Map<string, number>(), active: false,
  };
  pacers.set(providerName, state);
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { modelId, ...intervals, signal, resolve, reject };
    waiter.abort = () => {
      const index = state.queue.indexOf(waiter);
      if (index >= 0) state.queue.splice(index, 1);
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      reject(abortReason(signal!));
      runQueue(providerName, state);
    };
    signal?.addEventListener("abort", waiter.abort, { once: true });
    state.queue.push(waiter);
    // Abort may race between the eager check above and listener registration.
    if (signal?.aborted) {
      waiter.abort();
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    runQueue(providerName, state);
  });
}

export function providerRequestPacingStatus(
  providerName: string,
  provider: OcxProviderConfig,
  now = Date.now(),
): ProviderRequestPacingStatus {
  const state = pacers.get(providerName);
  let nextSlotAt = state?.providerNextStartAt ?? 0;
  if (state && state.queue.length > 0) {
    nextSlotAt = Math.min(...state.queue.map(waiter => Math.max(
      state.providerNextStartAt,
      waiter.modelId ? (state.modelNextStartAt.get(waiter.modelId) ?? 0) : 0,
    )));
  }
  return {
    provider: providerName,
    enabled: provider.requestPacing?.enabled === true,
    queued: state?.queue.length ?? 0,
    nextSlotInMs: Math.max(0, Math.ceil(nextSlotAt - now)),
    ...(state?.lastStartedAt !== undefined ? { lastStartedAt: state.lastStartedAt } : {}),
    ...(state?.lastModelId ? { lastModelId: state.lastModelId } : {}),
  };
}

export function resetProviderRequestPacingForTest(): void {
  for (const state of pacers.values()) if (state.timer) clearTimeout(state.timer);
  pacers.clear();
}
