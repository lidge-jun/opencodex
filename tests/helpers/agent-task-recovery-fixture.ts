import { spyOn } from "bun:test";
import * as cache from "../../src/server/responses/agent-task-recovery-cache";
import { codexHeaders, originalFetch } from "./agent-task-recovery";

const resolveRecovery = cache.resolveCachedAgentTaskRecoveryWithResult;
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
let sequence = 0;

/** Own the shared request callback, which can outlive its cancelled caller. */
export function createAgentTaskRecoveryFixture() {
  const marker = `recovery-fixture-${++sequence}`;
  const pending = new Set<Promise<unknown>>();
  const releases: Array<() => void> = [];
  const unexpected: Error[] = [];
  const foreign = new WeakSet<Request>();
  const abort = new AbortController();
  let isClosing = false;
  let closing: Promise<void> | undefined;
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const resolver = spyOn(cache, "resolveCachedAgentTaskRecoveryWithResult").mockImplementation(
    (key, maxEntries, request, signal) => resolveRecovery(key, maxEntries, abort => track(request(abort)), signal),
  );
  return {
    marker,
    track,
    signal: abort.signal,
    request: () => new Request("http://localhost/v1/responses", {
      headers: codexHeaders(marker, { "user-agent": marker }),
    }),
    releaseOnClose: (release: () => void) => { releases.push(release); },
    expectForeignFetch: (request: Request) => { foreign.add(request); },
    stub(handler: typeof fetch): void {
      globalThis.fetch = (async (input, init) => {
        const request = input instanceof Request ? input : null;
        const headers = new Headers(init?.headers ?? request?.headers);
        if (isClosing || String(request?.url ?? input) !== endpoint || headers.get("user-agent") !== marker) {
          const error = new Error("foreign recovery fetch");
          if (!request || !foreign.delete(request)) unexpected.push(error);
          throw error;
        }
        return handler(input, init);
      }) as typeof fetch;
    },
    close(): Promise<void> {
      isClosing = true;
      return closing ??= (async () => {
        const failures: unknown[] = [];
        try {
          abort.abort();
          cache.resetAgentTaskRecoveryCache();
          for (const release of releases) {
            try { release(); } catch (error) { failures.push(error); }
          }
          // A handler can register its recovery callback while teardown is starting.
          while (pending.size) {
            const results = await Promise.allSettled([...pending]);
            for (const result of results) {
              if (result.status === "rejected" && result.reason !== abort.signal.reason) failures.push(result.reason);
            }
          }
          cache.resetAgentTaskRecoveryCache();
          failures.push(...unexpected);
        } finally {
          resolver.mockRestore();
          globalThis.fetch = originalFetch;
        }
        if (failures.length) throw new AggregateError(failures, "recovery fixture cleanup failed");
      })();
    },
  };
}
