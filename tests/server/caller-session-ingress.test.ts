import { describe, expect, spyOn, test } from "bun:test";
import * as callerIdentity from "../../src/server/caller-session-identity";
import * as lifecycle from "../../src/server/lifecycle";
import * as bodyAdmission from "../../src/server/inbound-body-admission";
import * as timeouts from "../../src/server/responses/fetch-helpers";
import { sessionLaneIdFromRequest } from "../../src/server/request-log-conversation";
import { ACCESS, PROXY_KEY, reserveIngressFixture } from "../helpers/reserve-ingress-fixture";

describe("caller session identity through admitted HTTP ingress", () => {
  for (const transport of ["responses", "messages", "chat"] as const) {
    test(`${transport} uses one promoted request for admission and upstream dispatch`, async () => {
      const fixture = await reserveIngressFixture({ configure: config => {
        config.apiKeys = [{ id: "second-caller", name: "Second fixture", createdAt: "2026-01-01T00:00:00.000Z", key: "caller-ingress-fixture-second" }];
      } });
      const blockedFetch = globalThis.fetch;
      const wires: Headers[] = [];
      const lanes: Array<string | undefined> = [];
      const promoted: Array<{ original: Request; rewritten: Request }> = [];
      const timedOut: Request[] = [];
      const bodyRequests: Request[] = [];
      const realPromotion = callerIdentity.withCallerSessionIdentity;
      const promotionSpy = spyOn(callerIdentity, "withCallerSessionIdentity").mockImplementation((req, admission) => {
        const rewritten = realPromotion(req, admission);
        promoted.push({ original: req, rewritten });
        return rewritten;
      });
      const realAdmission = lifecycle.tryAdmitTurn;
      const admissionSpy = spyOn(lifecycle, "tryAdmitTurn").mockImplementation(lane => {
        lanes.push(lane);
        return realAdmission(lane);
      });
      const realBodyWork = bodyAdmission.runAdmittedBodyWork;
      const bodySpy = spyOn(bodyAdmission, "runAdmittedBodyWork").mockImplementation((req, policy, limit, work, refusal) => {
        bodyRequests.push(req);
        return realBodyWork(req, policy, limit, work, refusal);
      });
      const realTimeout = timeouts.disableResponsesRequestTimeout;
      const timeoutSpy = spyOn(timeouts, "disableResponsesRequestTimeout").mockImplementation((req, server) => {
        timedOut.push(req);
        return realTimeout(req, server);
      });
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        if (req.url === "https://chatgpt.com/backend-api/codex/responses") wires.push(req.headers);
        // The existing fixture rejects unknown outbound requests; never fall through to live fetch.
        return blockedFetch(req);
      }, { preconnect() { /* No fixture opens an upstream socket. */ } });
      try {
        const headers = { "x-session-id": "shared-caller", "x-opencodex-api-key": PROXY_KEY, authorization: `Bearer ${ACCESS}` };
        const first = await fixture.request("public", transport, "openai/gpt-5.6-luna", headers);
        expect(first.status, first.text).toBe(200);
        expect(promoted).toHaveLength(1);
        expect(promoted[0]!.rewritten).not.toBe(promoted[0]!.original);
        expect(promoted[0]!.rewritten.headers.get("session_id")).toMatch(/^[a-f0-9]{64}$/);
        expect(wires).toHaveLength(1);
        expect(wires[0]!.get("session_id")).toBe(promoted[0]!.rewritten.headers.get("session_id"));
        expect(lanes).toEqual([sessionLaneIdFromRequest(wires[0]!)]);
        expect(bodyRequests).toEqual([promoted[0]!.rewritten]);
        expect(bodyRequests[0]).toBe(promoted[0]!.rewritten);
        expect(timedOut.length).toBeGreaterThan(0);
        expect(timedOut.every(req => req === promoted[0]!.original)).toBe(true);

        const second = await fixture.request("public", transport, "openai/gpt-5.6-luna", headers);
        expect(second.status, second.text).toBe(200);
        expect(wires[1]!.get("session_id")).toBe(wires[0]!.get("session_id"));
        expect(lanes[1]).toBe(lanes[0]);

        const local = await fixture.request("local", transport, "openai/gpt-5.6-luna", { "x-session-id": "local-caller", authorization: `Bearer ${ACCESS}` });
        expect(local.status, local.text).toBe(200);
        expect(wires[2]!.get("session_id")).toBe("local-caller");
        expect(lanes[2]).toBe(sessionLaneIdFromRequest(wires[2]!));

        const other = await fixture.request("public", transport, "openai/gpt-5.6-luna", {
          ...headers, "x-opencodex-api-key": "caller-ingress-fixture-second",
        });
        expect(other.status, other.text).toBe(200);
        expect(wires[3]!.get("session_id")).not.toBe(wires[0]!.get("session_id"));
        expect(lanes[3]).not.toBe(lanes[0]);
        const explicit = await fixture.request("public", transport, "openai/gpt-5.6-luna", { ...headers, session_id: "explicit-winner" });
        expect(explicit.status, explicit.text).toBe(200);
        expect(wires[4]!.get("session_id")).toBe("explicit-winner");
        expect(promoted[4]!.rewritten).toBe(promoted[4]!.original);

        const before = { promotions: promoted.length, lanes: lanes.length, wires: wires.length };
        const unauthorized = await fixture.request("public", transport, "openai/gpt-5.6-luna", { "x-session-id": "shared-caller" });
        expect(unauthorized.status).toBe(401);
        const hostile = await fixture.request("public", transport, "openai/gpt-5.6-luna", { ...headers, Origin: "https://hostile.example.test" });
        expect(hostile.status).toBe(403);
        expect({ promotions: promoted.length, lanes: lanes.length, wires: wires.length }).toEqual(before);
      } finally {
        timeoutSpy.mockRestore();
        bodySpy.mockRestore();
        admissionSpy.mockRestore();
        promotionSpy.mockRestore();
        globalThis.fetch = blockedFetch;
        await fixture.close();
      }
    });
  }
});
