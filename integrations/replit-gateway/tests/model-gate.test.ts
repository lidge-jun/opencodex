import { describe, expect, test } from "bun:test";
import { enforceRelayModel, extractRequestModel } from "../src/relay/model-gate";
import { toModelAllowlistSet } from "../src/models";

describe("model gate", () => {
  test("extracts model from JSON bodies", () => {
    const body = new TextEncoder().encode(JSON.stringify({ model: "gpt-4o", messages: [] }));
    expect(extractRequestModel(body)).toBe("gpt-4o");
  });

  test("rejects disallowed models before relay", () => {
    const allowlist = toModelAllowlistSet(["gpt-4o"]);
    const body = new TextEncoder().encode(JSON.stringify({ model: "gpt-4.1", messages: [] }));
    expect(enforceRelayModel(body, allowlist)).toEqual({
      ok: false,
      category: "model_not_allowed",
    });
  });

  test("accepts exact allowlisted models", () => {
    const allowlist = toModelAllowlistSet(["gpt-4o"]);
    const body = new TextEncoder().encode(JSON.stringify({ model: "gpt-4o", messages: [] }));
    expect(enforceRelayModel(body, allowlist)).toEqual({ ok: true, model: "gpt-4o" });
  });

  test("rejects case-variant model ids", () => {
    const allowlist = toModelAllowlistSet(["gpt-4o"]);
    const body = new TextEncoder().encode(JSON.stringify({ model: "GPT-4o", messages: [] }));
    expect(enforceRelayModel(body, allowlist)).toEqual({
      ok: false,
      category: "model_not_allowed",
    });
  });
});
