/**
 * Peek at a bounded prefix without consuming it from the caller-visible body.
 * A deadline leaves the in-flight read attached to the replay stream, which
 * preserves exact bytes plus cancellation and error propagation.
 */
export async function readBoundedPrefix(
  body: ReadableStream<Uint8Array>,
  maxBytes = 4096,
  stopWhen?: (prefix: Uint8Array) => boolean,
  maxWaitMs?: number,
): Promise<{ prefix: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  type ReaderResult = Awaited<ReturnType<typeof reader.read>>;
  type SettledReaderResult =
    | { kind: "value"; value: ReaderResult }
    | { kind: "error"; error: unknown };
  const readSettled = (): Promise<SettledReaderResult> => reader.read().then(
    value => ({ kind: "value", value }),
    error => ({ kind: "error", error }),
  );
  const chunks: Uint8Array[] = [];
  let remainder: Uint8Array | undefined;
  let pendingRead: Promise<SettledReaderResult> | undefined;
  let total = 0;
  const deadline = maxWaitMs === undefined ? undefined : performance.now() + Math.max(0, maxWaitMs);

  while (total < maxBytes) {
    const read = readSettled();
    let next: SettledReaderResult | undefined;
    if (deadline === undefined) {
      next = await read;
    } else {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        pendingRead = read;
        break;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      next = await Promise.race([
        read,
        new Promise<undefined>(resolve => {
          timer = setTimeout(() => resolve(undefined), remainingMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (next === undefined) {
        pendingRead = read;
        break;
      }
    }

    if (next.kind === "error") {
      pendingRead = Promise.resolve(next);
      break;
    }
    const { done, value } = next.value;
    if (done) break;
    const take = Math.min(value.byteLength, maxBytes - total);
    if (take > 0) {
      chunks.push(value.subarray(0, take));
      total += take;
      if (take < value.byteLength) remainder = value.subarray(take);
      if (stopWhen) {
        const candidate = new Uint8Array(total);
        let candidateOffset = 0;
        for (const chunk of chunks) {
          candidate.set(chunk, candidateOffset);
          candidateOffset += chunk.byteLength;
        }
        if (stopWhen(candidate)) break;
      }
    }
    if (remainder) break;
  }

  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.byteLength > 0) controller.enqueue(prefix);
      if (remainder && remainder.byteLength > 0) controller.enqueue(remainder);
    },
    async pull(controller) {
      try {
        let result: ReaderResult;
        if (pendingRead) {
          const settled = await pendingRead;
          pendingRead = undefined;
          if (settled.kind === "error") throw settled.error;
          result = settled.value;
        } else {
          result = await reader.read();
        }
        const { done, value } = result;
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { prefix, stream };
}

export function looksLikeSse(prefix: Uint8Array): boolean {
  const text = new TextDecoder().decode(prefix);
  return /^\s*(?::|(?:event|data|id|retry)(?::|$))/.test(text);
}
