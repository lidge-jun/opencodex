/** Buffer small JSON only; large bodies pass through without collecting the remainder. */
export async function boundedJsonBody(body: ReadableStream<Uint8Array> | null, maxBytes = 262144): Promise<{ bytes: Buffer } | { stream: ReadableStream<Uint8Array> }> {
  if (!body) return { bytes: Buffer.alloc(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { reader.releaseLock(); return { bytes: Buffer.concat(chunks, count) }; }
      chunks.push(next.value); count += next.value.byteLength;
      if (count <= maxBytes && chunks.length < 1024) continue;
      let index = 0;
      return { stream: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (index < chunks.length) {
            const value = chunks[index]!; chunks[index++] = new Uint8Array(0); controller.enqueue(value); return;
          }
          try {
            const part = await reader.read();
            if (part.done) { reader.releaseLock(); controller.close(); }
            else controller.enqueue(part.value);
          } catch (error) { reader.releaseLock(); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
      }) };
    }
  } catch (error) { reader.releaseLock(); throw error; }
}
