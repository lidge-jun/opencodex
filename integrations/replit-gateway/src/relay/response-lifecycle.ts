/**
 * Wraps a response body so finalize runs exactly once on EOF, error, or cancel.
 */
export function attachResponseLifecycle(
  response: Response,
  finalize: () => void,
): Response {
  if (!response.body) {
    finalize();
    return response;
  }

  const wrapped = wrapStreamWithFinalizer(response.body, finalize);
  return new Response(wrapped, {
    status: response.status,
    headers: response.headers,
  });
}

export function wrapStreamWithFinalizer(
  source: ReadableStream<Uint8Array>,
  finalize: () => void,
): ReadableStream<Uint8Array> {
  let settled = false;
  const runFinalize = () => {
    if (settled) return;
    settled = true;
    finalize();
  };

  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          runFinalize();
          controller.close();
          return;
        }
        if (value) {
          controller.enqueue(value);
        }
      } catch {
        runFinalize();
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
      runFinalize();
    },
  });
}
