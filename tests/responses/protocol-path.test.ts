/**
 * The lane-to-path rule shared by the observed trace and the planner (src/protocols/path.ts).
 */
import { describe, expect, test } from "bun:test";
import { deliveryModeForLane, requestPathForLane, responsePathForLane } from "../../src/protocols/path";

describe("requestPathForLane", () => {
  test("Responses ingress passes through or translates through the IR", () => {
    expect(requestPathForLane("responses", "bridge", "responses")).toEqual(["responses", "responses"]);
    expect(requestPathForLane("responses", "bridge", "chat")).toEqual(["responses", "ir", "chat"]);
    expect(deliveryModeForLane("responses", "bridge", "responses")).toBe("native");
    expect(deliveryModeForLane("responses", "bridge", "messages")).toBe("translated");
  });

  test("a native lane keeps the ingress wire end to end", () => {
    expect(requestPathForLane("chat", "native", "chat")).toEqual(["chat", "chat"]);
    expect(deliveryModeForLane("messages", "native", "messages")).toBe("native");
  });

  test("a bridge lane to a Responses upstream is a direct codec, not a legacy bridge", () => {
    expect(requestPathForLane("chat", "bridge", "responses")).toEqual(["chat", "responses"]);
    expect(deliveryModeForLane("chat", "bridge", "responses")).toBe("translated");
  });

  test("any other bridge lane goes through the internal Responses body", () => {
    expect(requestPathForLane("messages", "bridge", "messages")).toEqual(["messages", "responses-internal", "ir", "messages"]);
    expect(deliveryModeForLane("chat", "bridge", "chat")).toBe("legacy-bridge");
    expect(deliveryModeForLane("chat", "bridge", "other")).toBe("legacy-bridge");
  });

  test("response paths run upstream first and end at the client wire", () => {
    expect(responsePathForLane("chat", "bridge", "other")).toEqual(["other", "ir", "responses-internal", "chat"]);
    expect(responsePathForLane("messages", "bridge", "responses")).toEqual(["responses", "messages"]);
    expect(responsePathForLane("responses", "bridge", "chat")).toEqual(["chat", "ir", "responses"]);
  });
});
