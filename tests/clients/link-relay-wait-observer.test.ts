import { afterEach, describe, expect, test } from "bun:test";
import { relayLinkDataRequest, type LinkTunnelGate } from "../../src/client/link-relay";
import { linkChildRelayWaitObserver, setLinkChildRelayWaitObserverForTests } from "../../src/client/link-websocket-limits";

// The Child's HTTP relay tells a test when a relayed response waits for its reader after handing it a chunk,
// and when it stops waiting: the counterpart of the Home's setLinkRelayWaitObserverForTests, used by the
// Child's memory acceptance (design 6.3) to see the relay hold a stalled reader without reading ahead.

const target = { tunnelPort: 12000, admissionKey: "ocx_data_" + "w".repeat(40) };
const tunnel: LinkTunnelGate = { connected: () => ({ kind: "match" }), pending: () => false, waitForConnected: async () => true };

afterEach(() => setLinkChildRelayWaitObserverForTests(null));

function upstream(chunks: string[], contentType: string): typeof fetch {
  return (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

async function relayed(chunks: string[], contentType: string): Promise<Response> {
  return await relayLinkDataRequest(new Request("http://127.0.0.1:10100/v1/responses", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
    target, { tunnel, fetchImpl: upstream(chunks, contentType) });
}

describe("the Child relay's test-only wait observer", () => {
  test("no observer is set by default", () => {
    expect(linkChildRelayWaitObserver()).toBeNull();
  });

  for (const contentType of ["application/json", "text/event-stream"]) {
    test("a " + contentType + " response waits from each chunk handed over until its reader asks again", async () => {
      const events: boolean[] = [];
      setLinkChildRelayWaitObserverForTests(waiting => events.push(waiting));
      const response = await relayed(["one", "two"], contentType);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      expect(decoder.decode((await reader.read()).value)).toBe("one");
      // The reader holds the first chunk and has not asked again: the relay waits for it.
      expect(events).toEqual([true]);
      expect(decoder.decode((await reader.read()).value)).toBe("two");
      expect(events).toEqual([true, false, true]);
      expect((await reader.read()).done).toBe(true);
      expect(events).toEqual([true, false, true, false]);
    });
  }

  test("a reader that cancels while the relay waits ends the wait", async () => {
    const events: boolean[] = [];
    setLinkChildRelayWaitObserverForTests(waiting => events.push(waiting));
    const response = await relayed(["one", "two"], "application/json");
    const reader = response.body!.getReader();
    await reader.read();
    expect(events).toEqual([true]);
    await reader.cancel();
    expect(events).toEqual([true, false]);
  });

  test("an observer that throws never breaks the relay", async () => {
    setLinkChildRelayWaitObserverForTests(() => { throw new Error("observer failed"); });
    const response = await relayed(["one", "two"], "text/event-stream");
    expect(await response.text()).toBe("onetwo");
  });
});
