import { describe, expect, test } from "bun:test";
import { isImageGenName, extractHostedImageGeneration, buildImageTool } from "../../src/images/synthetic-tool";

describe("isImageGenName", () => {
  test("'image_gen' → true", () => {
    expect(isImageGenName("image_gen")).toBe(true);
  });

  test("'IMAGE_GENERATION' → true (case insensitive)", () => {
    expect(isImageGenName("IMAGE_GENERATION")).toBe(true);
  });

  test("'imagegen' → false without hosted image tool context", () => {
    expect(isImageGenName("imagegen")).toBe(false);
  });

  test("'not_image' → false", () => {
    expect(isImageGenName("not_image")).toBe(false);
  });
});

describe("extractHostedImageGeneration", () => {
  test("type 'image_generation' → returns toolNames with that name", () => {
    const result = extractHostedImageGeneration([{ type: "image_generation" }]);
    expect(result).toBeDefined();
    expect(result!.toolNames.has("image_generation")).toBe(true);
  });

  test("flat Responses function tool with 'image_gen' name alone → does not activate", () => {
    const result = extractHostedImageGeneration([
      { type: "function", name: "image_gen", parameters: { type: "object" } },
    ]);
    expect(result).toBeUndefined();
  });

  test("nested Chat Completions function tool with 'image_gen' name alone → does not activate", () => {
    const result = extractHostedImageGeneration([
      { type: "function", function: { name: "image_gen" } },
    ]);
    expect(result).toBeUndefined();
  });

  test("no matching tools → undefined", () => {
    expect(
      extractHostedImageGeneration([{ type: "function", function: { name: "shell" } }]),
    ).toBeUndefined();
  });

  test("generate_image alone → undefined (alias requires hosted entry)", () => {
    expect(
      extractHostedImageGeneration([{ type: "function", name: "generate_image", parameters: { type: "object" } }]),
    ).toBeUndefined();
  });

  test("generate_image with hosted image_generation → matched for strip/replace", () => {
    const result = extractHostedImageGeneration([
      { type: "image_generation" },
      { type: "function", name: "generate_image", parameters: { type: "object" } },
    ]);
    expect(result).toBeDefined();
    expect(result!.toolNames.has("generate_image")).toBe(true);
    expect(result!.toolNames.has("image_generation")).toBe(true);
  });

  test("client image_gen with hosted image_generation → both collected", () => {
    const result = extractHostedImageGeneration([
      { type: "image_generation" },
      { type: "function", name: "image_gen", parameters: { type: "object" } },
    ]);
    expect(result).toBeDefined();
    expect(result!.toolNames.has("image_gen")).toBe(true);
    expect(result!.toolNames.has("image_generation")).toBe(true);
  });

  test("undefined → undefined", () => {
    expect(extractHostedImageGeneration(undefined)).toBeUndefined();
  });
});

describe("buildImageTool", () => {
  test("has name 'image_gen' and imageGeneration flag", () => {
    const tool = buildImageTool();
    expect(tool.name).toBe("image_gen");
    expect(tool.imageGeneration).toBe(true);
  });

  test("exposes aspect_ratio literals including auto", () => {
    const tool = buildImageTool();
    const aspect = (tool.parameters as { properties?: { aspect_ratio?: { enum?: string[] } } })
      .properties?.aspect_ratio;
    expect(aspect?.enum).toEqual(["1:1", "16:9", "9:16", "4:3", "3:4", "auto"]);
  });
});
