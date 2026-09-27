import { describe, expect, test } from "bun:test";
import { clientWireOf, markClientWire } from "../../src/server/inference/client-wire";

describe("client-wire marker", () => {
  test("a marked response reports its protocol and returns itself", () => {
    const response = new Response("{}");
    expect(markClientWire(response, "chat")).toBe(response);
    expect(clientWireOf(response)).toBe("chat");
  });

  test("an unmarked or cloned response carries no mark", () => {
    const marked = markClientWire(new Response("{}"), "messages");
    expect(clientWireOf(new Response("{}"))).toBeUndefined();
    expect(clientWireOf(marked.clone())).toBeUndefined();
  });
});
