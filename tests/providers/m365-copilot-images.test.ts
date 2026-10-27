import { afterEach, expect, test } from "bun:test";
import { m365ImageUrls, uploadM365Images } from "../../src/adapters/m365-copilot/images";
import { createM365CopilotAdapter, clearM365CopilotConversations } from "../../src/adapters/m365-copilot";
import { createM365Conversation, m365ChatFrame } from "../../src/adapters/m365-copilot/transport";
import { M365_COPILOT_BASE_URL } from "../../src/providers/m365-copilot-models";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=";
const token = "header." + Buffer.from(JSON.stringify({ oid: "11111111-1111-1111-1111-111111111111", tid: "22222222-2222-2222-2222-222222222222", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".signature";
const provider = (fetch: typeof globalThis.fetch): OcxProviderConfig => ({ baseUrl: M365_COPILOT_BASE_URL, adapter: "m365-copilot", authMode: "oauth", apiKey: token, fetch });
afterEach(clearM365CopilotConversations);

test("image-capable registry covers new selectors without a vision sidecar", () => {
  const entry = getProviderRegistryEntry("m365-copilot")!;
  expect(entry.inputModalities).toEqual(["text", "image"]);
  expect(isModelVisionSidecarConsumer({ inputModalities: entry.inputModalities }, "Future_Model_99")).toBe(false);
});
test("uploads validated image bytes to the fixed Microsoft origin and attaches only the returned reference", async () => {
  const budget = createTranslatorBudget();
  let sends = 0;
  const p = provider((async (url, init) => {
    expect(String(url)).toBe(M365_COPILOT_BASE_URL + "/UploadFile");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + token);
    expect(init?.redirect).toBe("manual");
    const form = new URLSearchParams(init?.body as string);
    expect(form.get("FileBase64")).toBe(png); expect(form.get("scenario")).toBe("UploadImage");
    expect(form.get("conversationId")).toBe("fixture-conversation");
    return Response.json({ docId: "fixture-image-reference" });
  }) as typeof fetch);
  try {
    const images = await uploadM365Images([png], token, "Claude_Sonnet", "fixture-conversation", p, undefined, budget, () => sends++);
    expect(images[0]).toMatchObject({ id: "fixture-image-reference", messageAnnotationType: "ImageFile", messageAnnotationMetadata: { fileType: "png" } });
    const frame = m365ChatFrame("Describe the image", "Claude_Sonnet", createM365Conversation(), "fixture-request", images) as any;
    expect(frame.arguments[0].message.messageAnnotations).toEqual(images);
    expect(JSON.stringify(frame)).not.toContain("base64"); expect(sends).toBeGreaterThan(0);
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});
test("invalid, oversized and private-network images fail instead of being silently dropped", async () => {
  let sends = 0;
  const p = provider((async () => { sends++; return Response.json({ docId: "fixture" }); }) as typeof fetch);
  for (const url of ["data:image/png;base64,!!!!", "data:image/png;base64,AB==", "data:text/html;base64,PGh0bWw+", "data:image/png;base64," + "A".repeat(7 * 1024 * 1024), "http://127.0.0.1/private-image"]) {
    await expect(uploadM365Images([url], token, "Magic", "fixture", p)).rejects.toThrow();
  }
  await expect(uploadM365Images(Array(5).fill(png), token, "Magic", "fixture", p)).rejects.toThrow("four");
  expect(sends).toBe(0);
});
test("foreign upload destinations, aborted requests and malformed upstream references are rejected", async () => {
  const p = provider((async () => Response.json({ docId: "bad\r\nreference" })) as typeof fetch);
  await expect(uploadM365Images([png], token, "Magic", "fixture", { ...p, baseUrl: "https://example.invalid" })).rejects.toThrow("fixed Microsoft");
  await expect(uploadM365Images([png], token, "Magic", "fixture", p, AbortSignal.abort())).rejects.toThrow();
  await expect(uploadM365Images([png], token, "Magic", "fixture", p)).rejects.toThrow("invalid image reference");
  const failing = provider((async () => new Response("fixture-private-upstream-body", { status: 403 })) as typeof fetch);
  await expect(uploadM365Images([png], token, "Magic", "fixture", failing)).rejects.toThrow("image upload failed");
});
test("adapter forwards fresh user and tool-result images and reuses earlier conversation images", async () => {
  let uploads = 0;
  const p = provider((async () => Response.json({ docId: "fixture-image-" + ++uploads })) as typeof fetch);
  const turns: any[] = [];
  const adapter = createM365CopilotAdapter(p, { turn: async o => { turns.push({ id: o.conversation.conversationId, images: o.images, text: o.text }); o.conversation.turns++; return "fixture reply"; } });
  const parsed: OcxParsedRequest = { modelId: "Claude_Sonnet", stream: false, options: {}, context: { messages: [
    { role: "user", content: [{ type: "text", text: "Describe this" }, { type: "image", imageUrl: png }], timestamp: 0 },
  ] } };
  const budget = createTranslatorBudget(); const events: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: budget }, e => events.push(e));
    parsed.context.messages.push({ role: "assistant", content: [{ type: "text", text: "fixture reply" }], timestamp: 1 });
    parsed.context.messages.push({ role: "user", content: "What color was it?", timestamp: 2 });
    await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: budget }, () => {});
    expect(uploads).toBe(1); expect(turns[1].images).toEqual([]); expect(turns[1].id).toBe(turns[0].id);
    const screenshotResult: OcxParsedRequest = { modelId: "Claude_Sonnet", stream: false, options: {}, context: { messages: [
      { role: "user", content: "Describe the tool screenshot", timestamp: 0 },
      { role: "toolResult", toolCallId: "fixture-call", toolName: "view_image", content: [{ type: "image", imageUrl: png }], isError: false, timestamp: 1 },
    ] } };
    expect(m365ImageUrls(screenshotResult.context.messages)).toEqual([png]);
    await adapter.runTurn!(screenshotResult, { headers: new Headers(), translatorBudget: budget }, () => {});
    expect(uploads).toBe(2); expect(turns[2].images).toHaveLength(1);
    expect(turns.every(t => !t.text.includes("base64"))).toBe(true);
    expect(events.find(e => e.type === "done")).toMatchObject({ usage: { estimated: true } });
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});
