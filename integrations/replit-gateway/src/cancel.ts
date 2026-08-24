export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export interface LinkedAbortHandle {
  controller: AbortController;
  dispose: () => void;
}

export function createLinkedAbortController(clientSignal: AbortSignal): LinkedAbortHandle {
  const controller = new AbortController();
  if (clientSignal.aborted) {
    controller.abort(clientSignal.reason);
    return { controller, dispose: () => {} };
  }
  const onAbort = () => controller.abort(clientSignal.reason);
  clientSignal.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose: () => clientSignal.removeEventListener("abort", onAbort),
  };
}

export interface TimeoutSignalHandle {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

export function createTimeoutSignal(
  timeoutMs: number,
  parent?: AbortSignal,
): TimeoutSignalHandle {
  const controller = new AbortController();
  let didTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);

  const abortFromParent = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    controller.abort(parent?.reason);
  };

  const dispose = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    parent?.removeEventListener("abort", abortFromParent);
  };

  if (parent) {
    if (parent.aborted) {
      dispose();
      controller.abort(parent.reason);
    } else {
      parent.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  controller.signal.addEventListener("abort", dispose, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose,
  };
}
