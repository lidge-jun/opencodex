import { describe, expect, test } from "bun:test";
import {
  checkOutboundBodySize,
  describeOutboundBodyRefusal,
} from "../src/server/responses/outbound-body-guard";

describe("outbound body guard", () => {
  test("an unconfigured limit admits without measuring", () => {
    // The whole default contract: no ceiling is inferred for any destination, so a body far
    // above any observed transport limit still goes out exactly as it does today.
    const huge = "x".repeat(20 * 1024 * 1024);
    const result = checkOutboundBodySize(huge, undefined);
    expect(result.admitted).toBe(true);
    expect(result.limit).toBe(0);
    // bytes stays 0 because the body was never measured — this is the cheap path.
    expect(result.bytes).toBe(0);
  });

  test("an explicit 0 disables the guard", () => {
    const huge = "x".repeat(20 * 1024 * 1024);
    expect(checkOutboundBodySize(huge, 0).admitted).toBe(true);
  });

  test("refuses only above the configured limit", () => {
    expect(checkOutboundBodySize("12345", 5).admitted).toBe(true);
    expect(checkOutboundBodySize("12345", 4).admitted).toBe(false);
  });

  test("measures UTF-8 bytes, not code units", () => {
    // A 1-character string is 3 bytes here; measuring .length would wrongly admit it.
    const result = checkOutboundBodySize("界", 2);
    expect(result.admitted).toBe(false);
    expect(result.bytes).toBe(3);
  });

  test("an unparseable oversized body still refuses, without diagnostics", () => {
    const result = checkOutboundBodySize("{not-json", 1);
    expect(result.admitted).toBe(false);
    expect(result.imageCount).toBe(0);
  });

  test("counts embedded input_image payloads and names them in the refusal", () => {
    const image = "A".repeat(4000);
    const body = JSON.stringify({
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: `data:image/png;base64,${image}` },
          { type: "input_image", image_url: `data:image/png;base64,${image}` },
        ],
      }],
    });
    const result = checkOutboundBodySize(body, 100);
    expect(result.admitted).toBe(false);
    expect(result.imageCount).toBe(2);
    expect(result.imageBytes).toBeGreaterThan(5000);

    const message = describeOutboundBodyRefusal(result);
    expect(message).toContain("2 input_image items");
    expect(message).toContain("compact the conversation");
  });

  test("finds images nested in function_call_output, not just message content", () => {
    // Replayed tool results are a common place for accumulated screenshots to hide.
    const body = JSON.stringify({
      input: [{
        type: "function_call_output",
        output: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
      }],
    });
    expect(checkOutboundBodySize(body, 10).imageCount).toBe(1);
  });

  test("a self-referential body cannot hang the diagnostic walk", () => {
    const body = JSON.stringify({ input: [{ type: "input_image", image_url: "data:,x" }] });
    expect(checkOutboundBodySize(body, 1).imageCount).toBe(1);
  });

  test("the singular form reads correctly for one image", () => {
    const body = JSON.stringify({
      input: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    });
    const message = describeOutboundBodyRefusal(checkOutboundBodySize(body, 10));
    expect(message).toContain("1 input_image item ");
  });
});
