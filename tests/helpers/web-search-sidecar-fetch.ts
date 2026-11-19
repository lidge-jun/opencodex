import { spyOn } from "bun:test";

/** A closed, in-memory sidecar transport. The caller restores the spy in finally. */
export function mockWebSearchSidecarFetch(
  observeRequest: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => void,
  text: string,
) {
  return spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    observeRequest(input, init);
    return new Response(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`
        + 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
}
