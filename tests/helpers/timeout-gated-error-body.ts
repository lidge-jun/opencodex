import { spyOn } from "bun:test";
import * as boundedBody from "../../src/lib/bounded-body";

/** Keep the upstream incomplete until the real bounded reader has timed out.
 * A wall timer started by the upstream precedes the proxy's inspection timer;
 * a 100ms gap between those timers is not a timeout guarantee on busy runners. */
export function timeoutGatedErrorBody(prefix: string, suffix: string) {
  const release: Array<() => void> = [];
  let timeouts = 0;
  const read = boundedBody.readBoundedResponseBody;
  const observation = spyOn(boundedBody, "readBoundedResponseBody").mockImplementation(async (...args) => {
    const result = await read(...args);
    if (args[0].status === 400 && result.timedOut) {
      timeouts += 1;
      for (const finish of release) finish();
    }
    return result;
  });
  return {
    stream: () => {
      let closed = false;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(prefix));
          release.push(() => {
            if (closed) return;
            closed = true;
            controller.enqueue(new TextEncoder().encode(suffix));
            controller.close();
          });
        },
        cancel() { closed = true; },
      });
    },
    observedTimeouts: () => timeouts,
    restore: () => {
      observation.mockRestore();
      for (const finish of release) finish();
    },
  };
}
