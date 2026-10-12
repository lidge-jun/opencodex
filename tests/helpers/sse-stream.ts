/**
 * Read one SSE body end to end, and build one from a string.
 *
 * Both are the same two functions nine test files had written out for themselves, which is how
 * they came to live here: a case at its file-size cap needed room for one more line, and the
 * repository answer to that is a sibling helper rather than compressed control flow. Moved
 * verbatim from tests/responses/responses-undeclared-tool-guard.test.ts, so a case that used the
 * local copies is reading exactly the same behaviour through a different name.
 */
export function streamFromText(text: string): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(chunk);
    },
  });
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}
