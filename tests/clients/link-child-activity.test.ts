import { describe, expect, test } from "bun:test";
import { createLinkActivity, DEFAULT_IDLE_AFTER_MS, isLinkIdle, linkActivityCounts } from "../../src/link/child-activity";
import { chunkedResponse, relayHarness } from "../helpers/link-relay-harness";

const LINK = "lnk_0123456789abcdef";
const OTHER = "lnk_fedcba9876543210";

describe("link child activity", () => {
  test("counts a relayed model POST until its body ends", async () => {
    let clock = 1_000;
    const activity = createLinkActivity({ now: () => clock });
    const h = relayHarness({ activity });
    const nonce = await h.session(LINK);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const response = await h.dispatch(h.request("/v1/responses", { method: "POST", body: "{}", nonce }),
      async () => chunkedResponse(["a", "b"], { status: 200 }, async index => { if (index === 1) await held; }));
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(activity.snapshot(LINK, clock)).toEqual({ inFlight: 1, lastDataEndAt: null, observedSince: 1_000 });
    expect(isLinkIdle(activity.snapshot(LINK, clock), clock + DEFAULT_IDLE_AFTER_MS)).toBe(false);
    clock = 5_000;
    release();
    while (!(await reader.read()).done) { /* drain */ }
    expect(activity.snapshot(LINK, clock)).toEqual({ inFlight: 0, lastDataEndAt: 5_000, observedSince: 1_000 });
    expect(activity.snapshot(OTHER, clock).lastDataEndAt).toBeNull();
  });

  test("abort ends the activity", async () => {
    const activity = createLinkActivity({ now: () => 7 });
    const h = relayHarness({ activity });
    const nonce = await h.session(LINK);
    const controller = new AbortController();
    let started!: () => void;
    const inside = new Promise<void>(resolve => { started = resolve; });
    const pending = h.dispatch(h.request("/v1/chat/completions", { method: "POST", body: "{}", nonce, signal: controller.signal }), async () => {
      started();
      await new Promise(resolve => setTimeout(resolve, 20));
      return new Response("late");
    });
    await inside;
    expect(activity.snapshot(LINK, 7).inFlight).toBe(1);
    controller.abort();
    expect(activity.snapshot(LINK, 7)).toMatchObject({ inFlight: 0, lastDataEndAt: 7 });
    await (await pending).body?.cancel();
    expect(activity.snapshot(LINK, 7).inFlight).toBe(0);
  });

  test("catalog, readyz and count_tokens do not count", async () => {
    const activity = createLinkActivity({ now: () => 1 });
    const h = relayHarness({ activity });
    for (const [path, method] of [["/v1/catalog", "GET"], ["/readyz", "GET"], ["/v1/messages/count_tokens", "POST"]] as const) {
      const nonce = await h.session(LINK);
      const response = await h.dispatch(h.request(path, { method, nonce, ...(method === "POST" ? { body: "{}" } : {}) }), async () => new Response("ok"));
      await response.text();
    }
    expect(activity.snapshot(LINK, 1)).toEqual({ inFlight: 0, lastDataEndAt: null, observedSince: 1 });
    const url = new URL("http://127.0.0.1/v1/messages/count_tokens");
    expect(linkActivityCounts(url, new Request(url, { method: "POST", body: "{}" }))).toBe(false);
    const responses = new URL("http://127.0.0.1/v1/responses");
    expect(linkActivityCounts(responses, new Request(responses, { method: "POST", body: "{}" }))).toBe(true);
  });

  test("legacy admission counts against every link", async () => {
    let clock = 10;
    const activity = createLinkActivity({ now: () => clock });
    const h = relayHarness({ activity });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const response = await h.dispatch(h.request("/v1/messages", { method: "POST", body: "{}" }),
      async () => chunkedResponse(["x"], { status: 200 }, async index => { if (index === 1) await held; }));
    const reader = response.body!.getReader();
    await reader.read();
    expect(activity.snapshot(LINK, clock).inFlight).toBe(1);
    expect(activity.snapshot(OTHER, clock).inFlight).toBe(1);
    clock = 20;
    release();
    while (!(await reader.read()).done) { /* drain */ }
    expect(activity.snapshot(OTHER, clock)).toMatchObject({ inFlight: 0, lastDataEndAt: 20 });
  });

  test("a legacy request refused 400, 401 or 403 records no data end and never raises inFlight", async () => {
    const activity = createLinkActivity({ now: () => 99 });
    const h = relayHarness({ activity });
    const seen: number[] = [];
    // 400 is the pre-auth refusal of an `Authorization: AgentAssertion` header on the hub-link ingress.
    for (const status of [400, 401, 403]) {
      const response = await h.dispatch(h.request("/v1/responses", { method: "POST", body: "{}" }), async () => {
        seen.push(activity.snapshot(LINK, 99).inFlight);
        return new Response("no", { status });
      });
      seen.push(activity.snapshot(LINK, 99).inFlight);
      await response.text();
    }
    expect(seen).toEqual([0, 0, 0, 0, 0, 0]);
    expect(activity.snapshot(LINK, 99)).toEqual({ inFlight: 0, lastDataEndAt: null, observedSince: 99 });
  });

  test("idle threshold", () => {
    let clock = 0;
    const activity = createLinkActivity({ now: () => clock });
    expect(isLinkIdle(activity.snapshot(LINK, 0), DEFAULT_IDLE_AFTER_MS - 1)).toBe(false);
    expect(isLinkIdle(activity.snapshot(LINK, 0), DEFAULT_IDLE_AFTER_MS)).toBe(true);
    clock = 1_000;
    const end = activity.begin(LINK);
    expect(isLinkIdle(activity.snapshot(LINK, clock), clock + 10 * DEFAULT_IDLE_AFTER_MS)).toBe(false);
    clock = 2_000;
    end();
    end();
    expect(activity.snapshot(LINK, clock)).toEqual({ inFlight: 0, lastDataEndAt: 2_000, observedSince: 0 });
    expect(isLinkIdle(activity.snapshot(LINK, clock), 2_000 + 60_000, 60_000)).toBe(true);
    expect(isLinkIdle(activity.snapshot(LINK, clock), 2_000 + 59_999, 60_000)).toBe(false);
  });
});
