/**
 * The unrepresentable-feature guard (PF-06, src/protocols/guard.ts): only a declared
 * `unsupported` disposition on the request path refuses, and only under the reject policy.
 */
import { describe, expect, test } from "bun:test";
import { checkRepresentable, unrepresentableMessage } from "../../src/protocols/guard";
import type { ProtocolFeature } from "../../src/protocols/features";

describe("checkRepresentable", () => {
  test("n > 1 on Chat into a Responses upstream is refused under reject", () => {
    expect(checkRepresentable({
      inbound: "chat",
      requestPath: ["chat", "responses"],
      features: ["request.multiple_choices", "request.tools"],
      policy: "reject",
    })).toEqual({ ok: false, features: ["request.multiple_choices"], reasonCodes: ["feature-unrepresentable"] });
  });

  test("the legacy policy never refuses", () => {
    expect(checkRepresentable({
      inbound: "chat",
      requestPath: ["chat", "responses"],
      features: ["request.multiple_choices", "request.seed"],
      policy: "legacy",
    })).toEqual({ ok: true });
  });

  test("a native same-wire path carries every feature", () => {
    expect(checkRepresentable({
      inbound: "chat",
      requestPath: ["chat", "chat"],
      features: ["request.multiple_choices", "request.logit_bias", "request.audio"],
      policy: "reject",
    })).toEqual({ ok: true });
  });

  test("degraded features pass; only unsupported ones refuse", () => {
    expect(checkRepresentable({
      inbound: "chat",
      requestPath: ["chat", "responses"],
      features: ["request.documents"],
      policy: "reject",
    })).toEqual({ ok: true });
  });

  test("a hop into an `other` adapter never refuses by itself", () => {
    const features: ProtocolFeature[] = ["request.background", "request.previous_response_id", "request.store"];
    expect(checkRepresentable({ inbound: "responses", requestPath: ["responses", "ir", "other"], features, policy: "reject" }))
      .toEqual({ ok: true });
    expect(checkRepresentable({
      inbound: "chat",
      requestPath: ["chat", "responses-internal", "ir", "other"],
      features: ["request.tools", "request.images"],
      policy: "reject",
    })).toEqual({ ok: true });
  });

  test("a loss declared before the `other` hop still refuses", () => {
    expect(checkRepresentable({
      inbound: "chat",
      requestPath: ["chat", "responses-internal", "ir", "other"],
      features: ["request.multiple_choices"],
      policy: "reject",
    })).toEqual({ ok: false, features: ["request.multiple_choices"], reasonCodes: ["feature-unrepresentable"] });
  });

  test("the refusal message names feature keys only", () => {
    expect(unrepresentableMessage(["request.multiple_choices", "request.seed"]))
      .toBe("The selected route cannot carry these request features: request.multiple_choices, request.seed");
  });
});
