import { expect, test } from "bun:test";
import { normalizeZaiResponsesInput } from "../../../src/adapters/openai-responses/zai-input";

const ZAI_URL = "https://api.z.ai/api/v1/responses";

test("degrades input_image detail 'original' to 'high' in message content and tool outputs for Z.AI", () => {
  const body = {
    model: "glm-5.3-flash",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe" },
          { type: "input_image", image_url: "data:image/png;base64,abc", detail: "original" },
          { type: "input_image", image_url: "data:image/png;base64,def", detail: "auto" },
        ],
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "Script completed" },
          { type: "input_image", image_url: "data:image/png;base64,ghi", detail: "original" },
        ],
      },
    ],
  };

  const normalized = normalizeZaiResponsesInput(body, ZAI_URL) as typeof body;
  expect(normalized.input[0]).toEqual({
    role: "user",
    content: [
      { type: "input_text", text: "Describe" },
      { type: "input_image", image_url: "data:image/png;base64,abc", detail: "high" },
      { type: "input_image", image_url: "data:image/png;base64,def", detail: "auto" },
    ],
  });
  expect(normalized.input[1]).toEqual({
    type: "custom_tool_call_output",
    call_id: "call_1",
    output: [
      { type: "input_text", text: "Script completed" },
      { type: "input_image", image_url: "data:image/png;base64,ghi", detail: "high" },
    ],
  });
});

test("leaves other destinations and unchanged bodies untouched", () => {
  const body = {
    input: [
      {
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,abc", detail: "original" }],
      },
    ],
  };
  expect(normalizeZaiResponsesInput(body, "https://api.openai.com/v1/responses")).toBe(body);

  const alreadyHigh = {
    input: [
      {
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,abc", detail: "high" }],
      },
    ],
  };
  expect(normalizeZaiResponsesInput(alreadyHigh, ZAI_URL)).toBe(alreadyHigh);
});
